import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { formatInt, search, TOKENIZER } from "@sieve/core";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

import { TOOLS, type ToolName, type ToolResult } from "@sieve/protocol";
import type { z } from "zod";
import type { DaemonContext } from "./context.ts";
import { execute, ISOLATION, type Jobs, type RunRequest, renderRun } from "./jobs.ts";

const GET_CAP = 100 * 1024;
const INDEX_MAX_FILES = 5000;
const INDEX_MAX_FILE_BYTES = 2 * 1024 * 1024;

export class ToolError extends Error {
  constructor(
    readonly code: "unknown_tool" | "invalid_args",
    message: string,
  ) {
    super(message);
  }
}

/** Validate args strictly; unknown fields are named in the error. */
export function parseArgs<T extends ToolName>(tool: T, args: unknown): z.infer<(typeof TOOLS)[T]["schema"]> {
  const def = TOOLS[tool];
  if (!def) throw new ToolError("unknown_tool", `unknown tool: ${tool}`);
  const r = def.schema.safeParse(args ?? {});
  if (!r.success) {
    const msg = r.error.issues
      .map((i) =>
        i.code === "unrecognized_keys"
          ? `unknown field(s): ${(i as { keys: string[] }).keys.join(", ")}`
          : `${i.path.join(".") || "args"}: ${i.message}`,
      )
      .join("; ");
    throw new ToolError("invalid_args", msg);
  }
  return r.data as z.infer<(typeof TOOLS)[T]["schema"]>;
}

const ok = (content: string): ToolResult => ({ content, isError: false });
const fail = (content: string): ToolResult => ({ content, isError: true });

function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export async function callTool(
  ctx: DaemonContext,
  jobs: Jobs,
  tool: string,
  rawArgs: unknown,
  cwd: string,
): Promise<ToolResult> {
  if (!(tool in TOOLS)) throw new ToolError("unknown_tool", `unknown tool: ${tool}`);
  const { ref, store } = ctx.project(cwd);
  const sessionId = store.currentSession(ref.worktree);

  switch (tool as ToolName) {
    case "sieve_run": {
      const a = parseArgs("sieve_run", rawArgs) as RunRequest;
      const finish = (o: Parameters<typeof renderRun>[0]) => {
        const text = renderRun(o, a, store, ref, sessionId);
        for (const id of store.unindexed(5)) ctx.indexLater(store, id);
        return text;
      };
      if (a.background) {
        const job = jobs.start(a, cwd, finish);
        return ok(`[sieve run] started in background: ${job.id}\nPoll with sieve_get {"id":"${job.id}"}`);
      }
      const outcome = await execute(a, cwd).done;
      return ok(finish(outcome));
    }

    case "sieve_batch": {
      const a = parseArgs("sieve_batch", rawArgs);
      const deadline = Date.now() + (a.timeoutMs ?? 600_000);
      const ids: string[] = [];
      const out = [`[sieve batch] ${plural(a.commands.length, "command")} · isolation: ${ISOLATION}`];
      for (const [i, cmd] of a.commands.entries()) {
        const left = deadline - Date.now();
        if (left <= 0) {
          out.push(`${i + 1}. skipped (batch time used up) · ${cmd}`);
          continue;
        }
        const o = await execute({ language: "shell", code: cmd, timeoutMs: left }, cwd).done;
        const status = o.spawnError
          ? `failed to start: ${o.spawnError}`
          : o.timedOut
            ? "timed out"
            : `exit ${o.exitCode}`;
        if (!o.output) {
          out.push(`${i + 1}. ${status} · ${(o.durationMs / 1000).toFixed(1)} s · no output · ${cmd}`);
          continue;
        }
        const item = store.put(o.output, {
          sessionId,
          worktree: ref.worktree,
          sourceKind: "run",
          source: `shell: ${cmd.slice(0, 160)}`,
        });
        store.index(item.id);
        ids.push(item.id);
        out.push(
          `${i + 1}. ${status} · ${(o.durationMs / 1000).toFixed(1)} s · ${formatInt(item.tokens)} tokens · ${item.id} · ${cmd}`,
        );
      }
      for (const q of a.queries) {
        const page = search(store.db, { query: q, archiveIds: ids, worktree: ref.worktree });
        const fixed = page.corrections.length
          ? ` (searched for ${page.corrections.map((c) => c.to).join(", ")})`
          : "";
        out.push("", `Q: ${q}${fixed}`);
        if (!page.hits.length) out.push("   no match in this batch's output");
        for (const h of page.hits.slice(0, 3)) {
          out.push(
            `   ${h.archiveId} lines ${h.startLine}-${h.endLine} · ${h.source}`,
            h.snippet.replace(/^/gm, "      "),
          );
        }
      }
      out.push("", `Expand any output: sieve_get {"id":"<id>"} or with "lines":"a-b"`);
      return ok(out.join("\n"));
    }

    case "sieve_get": {
      const a = parseArgs("sieve_get", rawArgs);
      if (a.id.startsWith("j_")) {
        const job = jobs.get(a.id);
        if (!job)
          return fail(`No background run ${a.id} in this daemon (runs are kept until the daemon restarts).`);
        if (job.result !== null) return ok(job.result);
        const partial = job.partial();
        const tail = partial.length > 2048 ? `…\n${partial.slice(-2048)}` : partial;
        return ok(
          `[sieve run ${a.id}] still running · ${ago(job.startedAt)} started · ${formatInt(job.bytes)} bytes so far\n${tail}`,
        );
      }
      const range = a.lines ? a.lines.split("-").map(Number) : null;
      if (range && range[0]! > range[1]!) return fail("lines: start must not be after end");
      const got = store.get(a.id, range ? { from: range[0]!, to: range[1]! } : undefined);
      if (!got)
        return fail(
          `Unknown id ${a.id} in project ${ref.name}. It may have expired (30 days unread) or belong to another project.`,
        );
      if (Buffer.byteLength(got.text) <= GET_CAP) return ok(got.text);
      // Too large for one reply: return whole lines up to the cap and say how to continue.
      const lines = got.text.split("\n");
      const first = range ? range[0]! : 1;
      let used = 0;
      let n = 0;
      while (n < lines.length && used + Buffer.byteLength(lines[n]!) + 1 <= GET_CAP)
        used += Buffer.byteLength(lines[n++]!) + 1;
      n = Math.max(n, 1);
      const last = first + n - 1;
      const end = range ? range[1]! : got.totalLines;
      return ok(
        `${lines.slice(0, n).join("\n")}\n[sieve] showing lines ${first}-${last} of ${end}. Continue: sieve_get {"id":"${a.id}","lines":"${last + 1}-${end}"}`,
      );
    }

    case "sieve_search": {
      const a = parseArgs("sieve_search", rawArgs);
      await ctx.queue.drain(); // make just-archived output searchable
      const scope = a.scope ?? "project";
      const page = search(store.db, {
        query: a.query,
        scope,
        ...(a.sort ? { sort: a.sort } : {}),
        ...(a.cursor ? { cursor: a.cursor } : {}),
        sessionId,
        worktree: ref.worktree,
      });
      if (page.total === 0) {
        const note = scope === "session" && !sessionId ? " (no active session is known for this folder)" : "";
        return ok(`No matches for "${a.query}" in ${scope} scope${note}.`);
      }
      const offset = a.cursor ? Number(a.cursor) : 0;
      const out = [
        `${page.total} hit(s) for "${a.query}" (${scope} scope), showing ${offset + 1}-${offset + page.hits.length}:`,
      ];
      page.hits.forEach((h, i) => {
        out.push(
          `\n${offset + i + 1}. ${h.archiveId} #${h.chunk} · ${h.source} · ${h.title} · ${ago(h.seenAt)}${h.stale ? " · CHANGED since read" : ""}`,
          h.snippet.replace(/^/gm, "   "),
        );
      });
      out.push(
        `\nExpand: sieve_get {"id":"<id>","lines":"a-b"}${
          page.nextCursor ? ` · More: sieve_search ${JSON.stringify({ ...a, cursor: page.nextCursor })}` : ""
        }`,
      );
      return ok(out.join("\n"));
    }

    case "sieve_index": {
      const a = parseArgs("sieve_index", rawArgs);
      if (a.content !== undefined) {
        const item = store.put(a.content, {
          sessionId,
          worktree: ref.worktree,
          sourceKind: "index",
          source: a.title ?? "content",
        });
        store.index(item.id);
        return ok(`Indexed ${a.title ?? "content"} as ${item.id} (${formatInt(item.tokens)} tokens).`);
      }
      const given = resolve(cwd, a.path!);
      if (!existsSync(given)) return fail(`No such path: ${given}`);
      const target = realpathSync(given);
      const files = statSync(target).isDirectory() ? listFiles(target) : [target];
      let indexed = 0;
      let skipped = 0;
      let tokens = 0;
      for (const f of files.slice(0, INDEX_MAX_FILES)) {
        const st = statSync(f);
        if (st.size > INDEX_MAX_FILE_BYTES || st.size === 0) {
          skipped++;
          continue;
        }
        const buf = readFileSync(f);
        if (buf.subarray(0, 8192).includes(0)) {
          skipped++;
          continue;
        }
        const item = store.put(buf.toString("utf8"), {
          sessionId,
          worktree: ref.worktree,
          sourceKind: "index",
          source: relative(ref.worktree, f) || f,
        });
        store.index(item.id);
        tokens += item.tokens;
        indexed++;
      }
      const capped =
        files.length > INDEX_MAX_FILES ? ` Stopped at ${INDEX_MAX_FILES} files of ${files.length}.` : "";
      return ok(
        `Indexed ${indexed} file(s), ${formatInt(tokens)} tokens; skipped ${skipped} (binary, empty, or over 2 MB).${capped}`,
      );
    }

    case "sieve_stats": {
      parseArgs("sieve_stats", rawArgs);
      const t = store.totals();
      const c = ctx.counters;
      const saved = c.tokensIn - c.tokensOut;
      const lines = [
        `Project ${ref.name}: ${formatInt(t.items)} archived item(s), ${formatInt(t.tokens)} tokens (${TOKENIZER}), seen ${formatInt(t.sightings)} time(s).`,
        `Since the daemon started: ${formatInt(c.folds)} fold(s), ${formatInt(c.tokensIn)} tokens in → ${formatInt(c.tokensOut)} returned${
          c.tokensIn ? ` (${Math.round((saved / c.tokensIn) * 100)}% fewer)` : ""
        }.`,
      ];
      for (const a of ctx.health.agents()) {
        lines.push(
          `Hooks ${a.agent}: last fired ${a.lastHookAt ? ago(a.lastHookAt) : "never"}, p50 ${a.latencyMs.p50} ms, p99 ${a.latencyMs.p99} ms (in daemon).`,
        );
      }
      return ok(lines.join("\n"));
    }
  }
}

/** Files under a directory: `git ls-files` inside a repo (honours every nested .gitignore), else a plain walk. */
export function listFiles(dir: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\0")
      .filter(Boolean)
      .map((f) => join(dir, f))
      .filter((f) => existsSync(f) && statSync(f).isFile());
  } catch {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) out.push(p);
        if (out.length > INDEX_MAX_FILES) return;
      }
    };
    walk(dir);
    return out;
  }
}
