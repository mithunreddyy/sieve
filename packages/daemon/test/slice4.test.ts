import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as claudeCode from "@sieve/adapter-claude-code";
import { PROTOCOL_VERSION, type ToolResult } from "@sieve/protocol";
import { ADAPTERS, Daemon, handleHook } from "../src/index.ts";
import { freshHome, runShim } from "./helpers.ts";

let env: ReturnType<typeof freshHome>;
let daemon: Daemon;
let repo: string;

beforeAll(async () => {
  env = freshHome();
  repo = join(env.home, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "limiter.ts"), "export function refreshLimiter() {}\n");
  daemon = new Daemon({ idleMinutes: 0, log: () => {} });
  expect(await daemon.start()).toBe(true);
});
afterAll(async () => {
  await daemon.stop();
  env.cleanup();
});

type Out = { additionalContext?: string; updatedToolOutput?: unknown };
async function hook(session: string, event: string, extra: Record<string, unknown>): Promise<Out | null> {
  const r = await runShim({ session_id: session, cwd: repo, hook_event_name: event, ...extra }, {}, event);
  expect(r.code).toBe(0);
  return r.stdout ? (JSON.parse(r.stdout).hookSpecificOutput as Out) : null;
}
const prompt = (s: string, text: string) => hook(s, "UserPromptSubmit", { prompt: text });
const post = (s: string, tool_name: string, tool_input: unknown, tool_response: unknown) =>
  hook(s, "PostToolUse", { tool_name, tool_input, tool_response });
const bash = (s: string, command: string, stdout: string) =>
  post(s, "Bash", { command }, { stdout, stderr: "", interrupted: false });
async function tool(name: string, args: unknown): Promise<ToolResult> {
  const r = await daemon.handleLine(
    JSON.stringify({ v: PROTOCOL_VERSION, id: "t", type: "tool", tool: name, args, cwd: repo }),
  );
  if (!r.ok) throw new Error(r.error.message);
  return r.result as ToolResult;
}
const ask = (s: string, question: string, answer: string) =>
  post(
    s,
    "AskUserQuestion",
    { questions: [{ question, header: "Storage", options: [{ label: "Redis" }, { label: "SQLite" }] }] },
    { questions: [{ question, header: "Storage" }], answers: { [question]: answer } },
  );

const FAILING =
  "FAIL src/limiter.test.ts > blocks after 5 tries\nError: expected 6 to be 5\n  at src/limiter.ts:12:3\n";

describe("session log → state block after compaction", () => {
  test("a session's steps come back as the state block on SessionStart(compact)", async () => {
    expect(await hook("A", "SessionStart", { source: "startup" })).toBeNull(); // no decisions yet
    expect(await prompt("A", "add rate limiting to the login route")).toBeNull(); // nothing to recall
    await post(
      "A",
      "Edit",
      { file_path: join(repo, "src", "limiter.ts"), old_string: "a", new_string: "b" },
      {},
    );
    await bash("A", "bun test", FAILING);
    await ask("A", "Where should the limiter keep its counters?", "Redis");
    await post(
      "A",
      "TodoWrite",
      {
        todos: [
          { content: "Write the limiter", status: "completed", activeForm: "Writing" },
          { content: "Make the limiter test pass", status: "in_progress", activeForm: "Fixing" },
        ],
      },
      {},
    );
    await post("A", "ExitPlanMode", { plan: "# Rate limiting plan\n\n1. Limiter\n2. Tests" }, {});
    expect(await hook("A", "Stop", {})).toBeNull();
    await daemon.ctx.queue.drain();
    const { store } = daemon.ctx.project(repo);
    expect(store.log.freshState("A")).toContain("[sieve state]"); // precomputed after turn.end

    expect(await hook("A", "PreCompact", { trigger: "auto" })).toBeNull();
    const ctx = (await hook("A", "SessionStart", { source: "compact" }))?.additionalContext ?? "";
    expect(ctx).toContain("goal and last request (#1): add rate limiting to the login route");
    expect(ctx).toContain(
      "- #4 bun test: FAIL src/limiter.test.ts > blocks after 5 tries (+1 more error lines)",
    );
    expect(ctx).toContain("- Storage: Redis (#5)");
    expect(ctx).toMatch(
      /- plan: approved "Rate limiting plan" \(full plan: sieve_get \{"id":"s_[a-z2-7]+"\}\) \(#7\)/,
    );
    expect(ctx).toContain("- [in progress] Make the limiter test pass");
    expect(ctx).toContain("files changed: src/limiter.ts");
    expect(Buffer.byteLength(ctx)).toBeLessThanOrEqual(2048);
  });

  test("sieve_resume gives the state block, and any row in full", async () => {
    const all = await tool("sieve_resume", {});
    expect(all.content).toContain("[sieve state]");
    const row = await tool("sieve_resume", { seq: 4 });
    expect(row.content).toContain("#4 error");
    expect(row.content).toMatch(/Expand: sieve_get \{"id":"s_/);
    const missing = await tool("sieve_resume", { seq: 999 });
    expect(missing.isError).toBe(true);
    await expect(tool("sieve_resume", { seq: 1, session: "x" })).rejects.toThrow("unknown field(s): session");
  });

  test("a passing rerun closes the open error", async () => {
    await bash("A", "bun test", "PASS src/limiter.test.ts\n2 passed\n");
    expect((await tool("sieve_resume", {})).content).not.toContain("open errors");
  });

  test("a long prompt becomes a pointer, and sieve_resume returns it exactly", async () => {
    const long = `Please restructure the limiter:\n${"- keep the window sliding and the counters per user\n".repeat(12)}`;
    await prompt("A", long);
    const block = (await tool("sieve_resume", {})).content;
    const m = /last request \(#(\d+)\): a long request \([\d,]+ chars\), sieve_resume \{"seq":(\d+)\}/.exec(
      block,
    );
    expect(m).not.toBeNull();
    const full = await tool("sieve_resume", { seq: Number(m![1]) });
    expect(full.content).toContain(long);
  });
});

describe("decisions across sessions", () => {
  test("a new session starts with the worktree's decisions; a newer answer replaces the older", async () => {
    const start = (await hook("B", "SessionStart", { source: "startup" }))?.additionalContext ?? "";
    expect(start).toContain("[sieve] Decisions in force for this worktree");
    expect(start).toContain("- Storage: Redis (earlier session)");
    await ask("B", "Where should the limiter keep its counters?", "SQLite");
    const { store, ref } = daemon.ctx.project(repo);
    const texts = store.log.decisions(ref.worktree).map((d) => d.text);
    expect(texts).toContain("SQLite");
    expect(texts).not.toContain("Redis");
  });
});

describe("recall pointers", () => {
  test("a prompt naming a file or symbol gets pointers to earlier output, once", async () => {
    await daemon.ctx.queue.drain(); // session A's output is indexed in the background
    const ctx = (await prompt("B", "why does refreshLimiter fail in limiter.ts?"))?.additionalContext ?? "";
    expect(ctx).toContain("[sieve] Earlier output matching this request");
    expect(ctx).toContain("Bash: bun test");
    expect(ctx).toMatch(/sieve_get \{"id":"s_[a-z2-7]+","lines":"\d+-\d+"\}/);
    // the pointers are their own section; a memory block (from an earlier decision) may precede it
    expect(ctx.slice(ctx.indexOf("[sieve] Earlier output")).split("\n").length).toBeLessThanOrEqual(4);
    // The same pointers are not repeated in this context window.
    expect(await prompt("B", "and refreshLimiter in limiter.ts again?")).toBeNull();
  });
  test("an ordinary prompt adds nothing", async () => {
    expect(await prompt("C", "thanks, that looks good")).toBeNull();
  });
});

describe("gap filling", () => {
  test("an agent that cannot add context at session start gets the state block on the next prompt", async () => {
    ADAPTERS.nostart = {
      ...claudeCode,
      capabilities: { ...claudeCode.capabilities, contextAt: ["prompt.submit"] },
      render: (ev, reply) => reply.context ?? (ev.kind === "prompt.submit" ? "" : ""),
    };
    const raw = (event: string, extra: Record<string, unknown> = {}) => ({
      session_id: "A",
      cwd: repo,
      hook_event_name: event,
      ...extra,
    });
    expect(handleHook(daemon.ctx, "nostart", "PreCompact", raw("PreCompact")).stdout).toBe("");
    expect(
      handleHook(daemon.ctx, "nostart", "SessionStart", raw("SessionStart", { source: "compact" })).stdout,
    ).toBe("");
    const out = handleHook(
      daemon.ctx,
      "nostart",
      "UserPromptSubmit",
      raw("UserPromptSubmit", { prompt: "go on" }),
    ).stdout;
    expect(out).toContain("[sieve state]");
    // Delivered once.
    expect(
      handleHook(daemon.ctx, "nostart", "UserPromptSubmit", raw("UserPromptSubmit", { prompt: "go on" }))
        .stdout,
    ).not.toContain("[sieve state]");
    delete ADAPTERS.nostart;
  });
});

describe("robustness", () => {
  test("a todo list longer than a row holds stays valid: whole items only", async () => {
    const todos = Array.from({ length: 60 }, (_, i) => ({
      content: `Step ${i}: ${"carefully migrate one more module ".repeat(3)}`,
      status: "pending",
      activeForm: "Working",
    }));
    await post("D", "TodoWrite", { todos }, {});
    const { store } = daemon.ctx.project(repo);
    const r = await tool("sieve_resume", { seq: store.log.lastSeq("D") });
    expect(r.isError).toBe(false);
    expect(r.content).toContain("- [pending] Step 0:");
    expect(r.content).not.toContain("Step 59:");
    expect(daemon.ctx.counters.sessionErrors).toBe(0);
  });
});
