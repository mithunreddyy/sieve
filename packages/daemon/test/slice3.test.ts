import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION, type ToolResult } from "@sieve/protocol";
import { Daemon } from "../src/index.ts";
import { freshHome, runShim } from "./helpers.ts";

let env: ReturnType<typeof freshHome>;
let daemon: Daemon;
let repo: string;
const SESSION = "s3";

const git = (...a: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], {
    cwd: repo,
    stdio: "pipe",
  }).toString();
const bigTs = Array.from(
  { length: 600 },
  (_, i) => `export function handler${i}(req: Request) {\n  return limitRate(req, ${i});\n}`,
).join("\n");

beforeAll(async () => {
  env = freshHome();
  repo = join(env.home, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "routes.ts"), bigTs);
  writeFileSync(join(repo, "src", "small.ts"), "export const port = 8080;\n");
  writeFileSync(join(repo, "README.md"), "# Repo\n");
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  daemon = new Daemon({ idleMinutes: 0, log: () => {} });
  expect(await daemon.start()).toBe(true);
});
afterAll(async () => {
  await daemon.stop();
  env.cleanup();
});

const base = (extra: Record<string, unknown> = {}) => ({ session_id: SESSION, cwd: repo, ...extra });
async function pre(file: string, extra: Record<string, unknown> = {}, input: Record<string, unknown> = {}) {
  const r = await runShim(
    base({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: join(repo, file), ...input },
      ...extra,
    }),
    {},
    "PreToolUse",
  );
  return r.stdout
    ? (JSON.parse(r.stdout).hookSpecificOutput as {
        permissionDecision: string;
        permissionDecisionReason: string;
      })
    : null;
}
async function post(file: string, extra: Record<string, unknown> = {}) {
  const content = readFileSync(join(repo, file), "utf8");
  const n = content.split("\n").length;
  await runShim(
    base({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: join(repo, file) },
      tool_response: {
        type: "text",
        file: { filePath: join(repo, file), content, numLines: n, startLine: 1, totalLines: n },
      },
      ...extra,
    }),
  );
}
async function prompt(text: string) {
  const r = await runShim(
    base({ hook_event_name: "UserPromptSubmit", prompt: text }),
    {},
    "UserPromptSubmit",
  );
  return r.stdout ? (JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string) : null;
}
async function bash(command: string, stdout: string) {
  const r = await runShim(
    base({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command },
      tool_response: { stdout, stderr: "", interrupted: false },
    }),
  );
  return r.stdout ? (JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput.stdout as string) : null;
}
async function tool(name: string, args: unknown): Promise<ToolResult> {
  const r = await daemon.handleLine(
    JSON.stringify({ v: PROTOCOL_VERSION, id: "t", type: "tool", tool: name, args, cwd: repo }),
  );
  if (!r.ok) throw new Error(r.error.message);
  return r.result as ToolResult;
}
const until = async (f: () => Promise<boolean> | boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return true;
    await Bun.sleep(40);
  }
  return false;
};

describe("smart reads through Claude Code hooks", () => {
  test("a large file not indexed yet is let through, and outlined in the background for next time", async () => {
    const { DaemonContext, smartReadBefore } = await import("../src/index.ts");
    const { loadConfig } = await import("@sieve/core");
    const cfg = loadConfig();
    cfg.watch.enabled = false; // nothing indexes the file except the read path itself
    const ctx = new DaemonContext(join(env.home, "unit-global.db"), cfg);
    ctx.outliner.start();
    expect(await until(() => ctx.outliner.ready, 10_000)).toBe(true);
    const dir = join(env.home, "plain");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "fresh.ts"), bigTs);
    const { ref, store } = ctx.project(dir);
    const reader = { sessionId: "u", context: "main" };
    const hints = { again: "read it again", range: (a: number, b: number) => `Read ${a}-${b}` };
    const t0 = performance.now();
    expect(smartReadBefore(ctx, store, ref, reader, join(dir, "fresh.ts"), dir, hints)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(25); // nothing is parsed on the hook
    await ctx.queue.drain();
    expect(smartReadBefore(ctx, store, ref, reader, join(dir, "fresh.ts"), dir, hints)).toContain(
      "outline (600 symbols",
    );
    ctx.close();
  });

  test("a large file is declined once with its outline and the lines for the request", async () => {
    await runShim(base({ hook_event_name: "SessionStart", source: "startup" }), {}, "SessionStart");
    await prompt("where is handler417 rate limited?");
    // The watcher indexes the repo in the background; smart reads use that index.
    expect(
      await until(
        () => (daemon.status().watchers.find((w) => w.worktree === realpathSync(repo))?.symbols ?? 0) >= 600,
        10_000,
      ),
    ).toBe(true);
    const d = await pre("src/routes.ts");
    expect(d?.permissionDecision).toBe("deny");
    expect(d?.permissionDecisionReason).toContain("src/routes.ts: 1,800 lines");
    expect(d?.permissionDecisionReason).toContain("export function handler0(req: Request) {");
    expect(d?.permissionDecisionReason).toContain("1253│   return limitRate(req, 417);");
    expect(d?.permissionDecisionReason).toContain("Read with offset 1252 and limit 3");
    // Asking again gets the whole file.
    expect(await pre("src/routes.ts")).toBeNull();
    // Partial reads always go through.
    expect(await pre("src/routes.ts", {}, { offset: 1252, limit: 3 })).toBeNull();
  });

  test("re-reading an unchanged file says so once; asking again goes through", async () => {
    expect(await pre("src/small.ts")).toBeNull(); // first read of a small file
    await post("src/small.ts");
    const d = await pre("src/small.ts");
    expect(d?.permissionDecisionReason).toContain("unchanged since your read #1");
    expect(await pre("src/small.ts")).toBeNull();
  });

  test("after a change, only the changed hunks", async () => {
    await post("src/routes.ts");
    writeFileSync(
      join(repo, "src", "routes.ts"),
      bigTs.replace("return limitRate(req, 300);", "return limitRate(req, 999);"),
    );
    const d = await pre("src/routes.ts");
    expect(d?.permissionDecisionReason).toContain("changed since your read #");
    expect(d?.permissionDecisionReason).toContain("+  return limitRate(req, 999);");
  });

  test("a subagent never hears 'unchanged' about the main thread's reads", async () => {
    await post("src/small.ts");
    expect(await pre("src/small.ts", { agent_id: "sub-1", agent_type: "Explore" })).toBeNull();
  });

  test("after compaction nothing is claimed to be in context", async () => {
    await post("src/small.ts");
    await runShim(base({ hook_event_name: "SessionStart", source: "compact" }), {}, "SessionStart");
    expect(await pre("src/small.ts")).toBeNull();
  });

  test("the agent's own edits count as known content", async () => {
    writeFileSync(join(repo, "src", "small.ts"), "export const port = 9090;\n");
    await runShim(
      base({
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: join(repo, "src", "small.ts"), old_string: "8080", new_string: "9090" },
        tool_response: { filePath: join(repo, "src", "small.ts") },
      }),
    );
    const d = await pre("src/small.ts");
    expect(d?.permissionDecisionReason).toContain("unchanged since your own edit");
    await pre("src/small.ts"); // consume the decline
  });
});

describe("staleness", () => {
  test("files changed on disk since they were read are named on the next prompt, once", async () => {
    await post("README.md");
    expect(await prompt("nothing changed yet")).toBeNull();
    writeFileSync(join(repo, "README.md"), "# Repo\nedited by the user\n");
    const note = await prompt("next");
    expect(note).toContain("README.md (changed");
    expect(await prompt("again")).toBeNull();
  });

  test("a git checkout is named as the cause", async () => {
    git("add", ".");
    git("commit", "-q", "-m", "work");
    git("checkout", "-q", "-b", "other");
    writeFileSync(join(repo, "README.md"), "# Repo on other\n");
    git("commit", "-q", "-am", "other");
    git("checkout", "-q", "main");
    await post("README.md");
    git("checkout", "-q", "other");
    await Bun.sleep(400);
    const note = await prompt("what changed?");
    expect(note).toContain("README.md (changed, after git: checkout: moving from main to other)");
    git("checkout", "-q", "main");
  });
});

describe("reruns", () => {
  const out = (n: number) =>
    Array.from({ length: 300 }, (_, i) => `step ${i} ${i === 120 && n === 2 ? "FAILED" : "ok"}`).join("\n");
  test("an identical rerun is one line", async () => {
    await bash("./check.sh", out(1));
    const r = await bash("./check.sh", out(1));
    expect(r).toContain("Same output as run #1 of this command");
  });
  test("a small change shows only the changed lines", async () => {
    const r = await bash("./check.sh", out(2));
    expect(r).toContain("Changed since run #2 of this command");
    expect(r).toContain("+step 120 FAILED");
  });
});

describe("watcher and search", () => {
  test("new files are indexed with their symbols", async () => {
    writeFileSync(
      join(repo, "src", "limiter.ts"),
      "export class TokenBucketLimiter {\n  take(n: number) {\n    return n;\n  }\n}\n",
    );
    expect(
      await until(async () =>
        (await tool("sieve_search", { query: "TokenBucket" })).content.includes(
          "src/limiter.ts:1-5  class TokenBucketLimiter",
        ),
      ),
    ).toBe(true);
    const r = await tool("sieve_search", { query: "TokenBucket take" });
    expect(r.content).toContain("method TokenBucketLimiter.take");
  });
  test("search hits from files that changed since are flagged", async () => {
    writeFileSync(join(repo, "src", "notes.md"), "# Notes\nThe zanzibar flag is on.\n");
    await tool("sieve_index", { path: "src/notes.md" });
    writeFileSync(join(repo, "src", "notes.md"), "# Notes\nThe zanzibar flag is off.\n");
    expect(
      await until(async () =>
        (await tool("sieve_search", { query: "zanzibar" })).content.includes("CHANGED on disk"),
      ),
    ).toBe(true);
  });
  test("search says when it corrected a spelling", async () => {
    const r = await tool("sieve_search", { query: "zanzibr" });
    expect(r.content).toContain('No exact match for "zanzibr"; searched for "zanzibar" instead.');
  });
  test("status lists the watcher", () => {
    const w = daemon.status().watchers.find((x) => x.worktree === realpathSync(repo));
    expect(w?.files).toBeGreaterThan(2);
    expect(w?.symbols).toBeGreaterThan(600);
  });
});

describe("sieve_read", () => {
  test("outline for a large file, ranges on request, the whole file with full: true", async () => {
    const o = await tool("sieve_read", { path: "src/routes.ts", intent: "handler5 limit" });
    expect(o.content).toContain("outline");
    expect(o.content).toContain('Call sieve_read with "ranges"');
    const r = await tool("sieve_read", { path: "src/routes.ts", ranges: ["1-3"] });
    expect(r.content).toContain("     1│ export function handler0(req: Request) {");
    const f = await tool("sieve_read", { path: "src/small.ts", full: true });
    expect(f.content).toContain("export const port = 9090;");
    const again = await tool("sieve_read", { path: "src/small.ts" });
    expect(again.content).toContain("unchanged since your read");
  });
  test("rejects unknown arguments", async () => {
    const r = await daemon.handleLine(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        id: "t",
        type: "tool",
        tool: "sieve_read",
        args: { path: "x", lines: "1-2" },
        cwd: repo,
      }),
    );
    expect(r.ok).toBe(false);
  });
});
