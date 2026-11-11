import { spawn } from "node:child_process";
import { maskSecrets, type ProjectRef, type ProjectStore } from "@sieve/core";
import { z } from "zod";
import type { DaemonContext } from "./context.ts";
import { whereOf } from "./memory.ts";

/**
 * Optional fact extraction (slice 12): after a turn, a model you choose suggests up to 5 short
 * facts. Off by default. It runs on the background queue, never on the hook path, and what it
 * returns is stored as `inferred` (the lowest trust: never in the always-on block, never able to
 * replace a more trusted value).
 *
 * Providers:
 *  - "command": a program you name, started without a shell; JSON on stdin, JSON on stdout. Wrap any
 *    local model, or your own API key, in it. Sieve passes it nothing but the text below.
 *  - "ollama": a model server on THIS machine (a non-loopback URL is refused).
 *
 * What is sent: the user's prompt for the turn and the one-line summaries of what the session logged
 * since the last extraction, all with secrets masked. Skipped when the prompt contains a credential
 * pattern, when there is no new user text, and when the turn is empty. (The turn.end hook carries no
 * "interrupted" flag, so an interrupted turn is not skipped.)
 */

const Fact = z
  .object({
    subject: z.string().min(1).max(120),
    predicate: z.string().min(1).max(60),
    object: z.string().min(1).max(500),
    scope: z.enum(["everywhere", "repo", "project", "worktree"]).optional(),
  })
  .strict();
const Reply = z.object({ facts: z.array(Fact).max(20) }).strict();
export type SuggestedFact = z.infer<typeof Fact>;

export const INSTRUCTIONS =
  'Suggest at most 5 short, lasting facts worth remembering for future sessions (project commands, conventions, decisions, user preferences). Not task details, not anything secret. Reply with JSON only: {"facts":[{"subject":"…","predicate":"…","object":"…","scope":"repo"}]}. Return {"facts":[]} if nothing qualifies.';

export interface ExtractionInput {
  prompt: string;
  activity: string[];
}

/** Why this turn is not sent to a model, or null if it may be. */
export function skipReason(input: ExtractionInput): string | null {
  if (!input.prompt.trim()) return "no new user text";
  if (maskSecrets(input.prompt).hits.length) return "the prompt matches a credential pattern";
  return null;
}

const loopback = (u: string) => {
  try {
    return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(u).hostname);
  } catch {
    return false;
  }
};

function runCommand(cmd: string[], payload: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const [bin, ...args] = cmd;
    const p = spawn(bin as string, args, { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const t = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error("extraction command timed out"));
    }, timeoutMs);
    p.stdout.on("data", (d: Buffer) => {
      if (out.length < 200_000) out += d.toString();
    });
    p.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(t);
      code === 0 ? resolve(out) : reject(new Error(`extraction command exited ${code}`));
    });
    p.stdin.on("error", () => {});
    p.stdin.end(payload);
  });
}

/** Ask the configured provider. Throws on any failure; the caller counts it and moves on. */
export async function suggest(ctx: DaemonContext, input: ExtractionInput): Promise<SuggestedFact[]> {
  const cfg = ctx.config.memory.extraction;
  if (cfg.provider === "off") return [];
  const payload = JSON.stringify({
    instructions: INSTRUCTIONS,
    prompt: input.prompt,
    activity: input.activity,
  });
  let raw: string;
  if (cfg.provider === "command") {
    if (!cfg.command.length) throw new Error("memory.extraction.command is empty");
    raw = await runCommand(cfg.command, payload, cfg.timeout_ms);
  } else {
    if (!loopback(cfg.url))
      throw new Error("extraction.url must be on this machine (127.0.0.1 or localhost)");
    const res = await fetch(new URL("/api/generate", cfg.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        prompt: `${INSTRUCTIONS}\n\n${payload}`,
        stream: false,
        format: "json",
      }),
      signal: AbortSignal.timeout(cfg.timeout_ms),
    });
    if (!res.ok) throw new Error(`model server answered ${res.status}`);
    raw = String(((await res.json()) as { response?: string }).response ?? "");
  }
  const parsed = Reply.parse(JSON.parse(raw));
  return parsed.facts.slice(0, 5);
}

/**
 * After a turn: build the (masked) input, ask, and store what comes back as inferred facts.
 * Returns how many were stored. Never throws.
 */
export async function extractAfterTurn(
  ctx: DaemonContext,
  store: ProjectStore,
  ref: ProjectRef,
  sessionId: string,
  now = Date.now(),
): Promise<number> {
  try {
    if (!ctx.config.memory.enabled || ctx.config.memory.extraction.provider === "off") return 0;
    const prompt = ctx.lastPrompt.get(sessionId) ?? "";
    // Only a prompt not already extracted from counts as new user text.
    if (ctx.extractedFrom.get(sessionId) === prompt) return 0;
    const rows = store.db
      .query("SELECT summary FROM session_log WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT 30")
      .all(sessionId, ctx.extractedSeq.get(sessionId) ?? 0) as Array<{ summary: string }>;
    const top = store.db
      .query("SELECT COALESCE(MAX(seq),0) AS n FROM session_log WHERE session_id = ?")
      .get(sessionId) as { n: number };
    const input: ExtractionInput = {
      prompt: store.mask(prompt, ref.worktree),
      activity: rows.map((r) => store.mask(r.summary, ref.worktree).slice(0, 200)),
    };
    const skip = skipReason({ prompt, activity: [] });
    ctx.extractedFrom.set(sessionId, prompt);
    ctx.extractedSeq.set(sessionId, top.n);
    if (skip) return 0;
    let stored = 0;
    for (const f of await suggest(ctx, input)) {
      const r = ctx.global.memory.remember(
        {
          subject: f.subject,
          predicate: f.predicate,
          object: f.object,
          scope: f.scope ?? "repo",
          writer: "model",
          at: now,
        },
        whereOf(ref),
      );
      if (r.status === "added") stored++;
    }
    return stored;
  } catch {
    ctx.counters.sessionErrors++;
    return 0;
  }
}
