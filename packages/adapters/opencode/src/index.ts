import type { AgentCapabilities, SieveEvent, SieveReply, ToolFamily, ToolRef } from "@sieve/protocol";

/**
 * OpenCode adapter (in-process plugin, ../plugin/sieve.ts). The plugin sends its own small
 * event names; this maps them to Sieve's events and renders `{context, replaceOutput, deny}`
 * for the plugin to apply. Shapes read from OpenCode 1.19.4 (binary) and @opencode-ai/plugin
 * 1.17.6 types; not yet exercised by a live session.
 *
 * - tool.execute.after hands the plugin a mutable result; setting `output` replaces what the
 *   model reads: a real replace, so receipts work as with Claude Code.
 * - experimental.session.compacting lets the plugin add context to the compaction prompt: the
 *   state block goes there, and the compaction is a known reset (it only fires when compacting).
 * - chat.message context is added as a synthetic text part of the user's message (once, never
 *   rewritten later: cache-safe). A system-prompt transform would change every request.
 * - Each subagent (task tool) runs as its own child session, so it is its own reader.
 */
export const AGENT = "opencode";

export const EVENTS = {
  "session.created": "session.start",
  "chat.message": "prompt.submit",
  "tool.execute.before": "tool.before",
  "tool.execute.after": "tool.after",
  "session.compacting": "compact.before",
  "session.idle": "turn.end",
  "session.deleted": "session.end",
} as const;

export const capabilities: AgentCapabilities = {
  replace: "all",
  route: true,
  contextAt: ["prompt.submit", "compact.before"],
  deny: true,
  ask: false,
  events: Object.values(EVENTS),
  compaction: "reliable",
  support: "preview",
};

interface Input {
  sessionID?: string;
  cwd?: string;
  prompt?: string;
  tool?: string;
  args?: unknown;
  output?: unknown;
  metadata?: unknown;
}

const FAMILY: Record<string, ToolFamily> = {
  bash: "shell",
  read: "read",
  edit: "edit",
  write: "edit",
  multiedit: "edit",
  patch: "edit",
  apply_patch: "edit",
  grep: "search",
  glob: "search",
  codesearch: "search",
  webfetch: "web",
  websearch: "web",
};

/** MCP tools are named `<server>_<tool>`; Sieve's own are `sieve_sieve_*`. */
export function toolRef(name: string): ToolRef {
  if (FAMILY[name]) return { name, family: FAMILY[name] };
  if (name.startsWith("sieve_sieve_")) return { name, family: "mcp", server: "sieve" };
  return { name, family: "other" };
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
/** OpenCode's tools have taken `filePath` and, in the newer tool set, `path`. */
const pathArg = (args: unknown) => {
  const a = asRecord(args);
  const p = a?.filePath ?? a?.path;
  return typeof p === "string" && p ? p : null;
};

export function readRequest(input: unknown): { path: string; full: boolean } | null {
  const p = pathArg(input);
  if (!p) return null;
  const a = asRecord(input)!;
  return { path: p, full: (a.offset === undefined || a.offset === 1) && a.limit === undefined };
}

/** A read is whole when it started at line 1 and OpenCode says it reached the end of the file. */
export function readWasWhole(response: unknown): boolean {
  const r = asRecord(response);
  const a = asRecord(r?.args);
  if (a && a.offset !== undefined && a.offset !== 1) return false;
  return typeof r?.output === "string" && /\(End of file - total \d+ lines\)/.test(r.output);
}

export const editedPath = (input: unknown) => pathArg(input);

export const readHints = {
  again: "read it again",
  range: (from: number, to: number) => `Read with offset ${from} and limit ${to - from + 1}`,
};

/** todowrite: `todos: [{ content, status, priority, id }]`. */
export function todoList(
  toolName: string,
  input: unknown,
): Array<{ content: string; status: string }> | null {
  if (toolName !== "todowrite") return null;
  const todos = asRecord(input)?.todos;
  if (!Array.isArray(todos)) return null;
  return todos
    .map(asRecord)
    .filter((t): t is Record<string, unknown> => !!t && typeof t.content === "string")
    .map((t) => ({
      content: t.content as string,
      status: typeof t.status === "string" ? t.status : "pending",
    }));
}

/**
 * question: answers come back as arrays of labels, one per question in order. The model sees
 * `User has answered your questions: "<q>"="<a, b>", …` (OpenCode 1.19.4); that text is parsed.
 */
export function answeredQuestions(
  toolName: string,
  input: unknown,
  response: unknown,
): Array<{ header?: string; question: string; answer: string }> {
  if (toolName !== "question") return [];
  const qs = asRecord(input)?.questions;
  const out = asRecord(response)?.output;
  if (!Array.isArray(qs) || typeof out !== "string") return [];
  const res: Array<{ header?: string; question: string; answer: string }> = [];
  for (const q of qs) {
    const qr = asRecord(q);
    if (!qr || typeof qr.question !== "string") continue;
    const marker = `"${qr.question}"="`;
    const at = out.indexOf(marker);
    if (at === -1) continue;
    const end = out.indexOf('"', at + marker.length);
    const answer = out.slice(at + marker.length, end === -1 ? undefined : end);
    if (!answer || answer === "Unanswered") continue;
    res.push({
      ...(typeof qr.header === "string" && qr.header.trim() ? { header: qr.header.trim() } : {}),
      question: qr.question,
      answer,
    });
  }
  return res;
}

/** bash results carry the exit code in metadata.exit. */
function isError(metadata: unknown): boolean {
  const m = asRecord(metadata);
  return typeof m?.exit === "number" && m.exit !== 0;
}

export function toEvent(eventName: string, raw: unknown, at: number): SieveEvent | null {
  const input = asRecord(raw) as Input | null;
  if (!input || typeof input.sessionID !== "string") return null;
  const base = {
    agent: AGENT,
    sessionId: input.sessionID,
    context: "main",
    cwd: input.cwd ?? process.cwd(),
    at,
  };
  switch (eventName) {
    case "session.created":
      return { kind: "session.start", base, source: "startup" };
    case "session.compacted":
      // After compaction: the reset was already handled when it started (session.compacting).
      return null;
    case "chat.message":
      return { kind: "prompt.submit", base, prompt: typeof input.prompt === "string" ? input.prompt : "" };
    case "tool.execute.before":
      return { kind: "tool.before", base, tool: toolRef(input.tool ?? ""), input: input.args };
    case "tool.execute.after":
      return {
        kind: "tool.after",
        base,
        tool: toolRef(input.tool ?? ""),
        input: input.args,
        output: {
          text: typeof input.output === "string" ? input.output : "",
          isError: isError(input.metadata),
        },
        response: { output: input.output, metadata: input.metadata, args: input.args },
      };
    case "session.compacting":
      return { kind: "compact.before", base, trigger: "auto" };
    case "session.idle":
      return { kind: "turn.end", base };
    case "session.deleted":
      return { kind: "session.end", base };
    default:
      return null;
  }
}

/** The plugin's reply: JSON with only the fields it should apply. Empty: change nothing. */
export function render(event: SieveEvent, reply: SieveReply, _raw: unknown): string {
  const out: { context?: string; replaceOutput?: string; deny?: string } = {};
  if (reply.context && capabilities.contextAt.includes(event.kind as never)) out.context = reply.context;
  if (event.kind === "tool.after" && reply.replaceOutput !== undefined)
    out.replaceOutput = reply.replaceOutput;
  if (event.kind === "tool.before" && reply.decision?.action === "deny") out.deny = reply.decision.reason;
  return Object.keys(out).length ? JSON.stringify(out) : "";
}

export * from "./setup.ts";
