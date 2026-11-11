import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION, type ToolResult } from "@sieve/protocol";
import { Daemon } from "../src/index.ts";
import { freshHome, SHIM } from "./helpers.ts";

let env: ReturnType<typeof freshHome>;
let daemon: Daemon;
let repo: string;

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
  daemon = new Daemon({ idleMinutes: 0, log: () => {} });
  expect(await daemon.start()).toBe(true);
});
afterAll(async () => {
  await daemon.stop();
  env.cleanup();
});

// runShim's agent argument is fixed to claude-code; spawn the shim for gemini-cli directly.
async function shim(event: string, extra: Record<string, unknown>, session = "G") {
  const p = Bun.spawn([SHIM, "gemini-cli", event], {
    stdin: Buffer.from(
      JSON.stringify({ session_id: session, cwd: repo, hook_event_name: event, timestamp: "t", ...extra }),
    ),
    stdout: "pipe",
    stderr: "pipe",
    // Explicitly: the test's SIEVE_HOME, never the developer's real daemon.
    env: { ...process.env },
  });
  const stdout = await new Response(p.stdout).text();
  const stderr = await new Response(p.stderr).text();
  expect(await p.exited).toBe(0);
  // Gemini CLI shows any stderr as a system message when stdout is empty.
  expect(stderr).toBe("");
  return stdout ? JSON.parse(stdout) : null;
}
async function tool(name: string, args: unknown): Promise<ToolResult> {
  const r = await daemon.handleLine(
    JSON.stringify({ v: PROTOCOL_VERSION, id: "t", type: "tool", tool: name, args, cwd: repo }),
  );
  if (!r.ok) throw new Error(r.error.message);
  return r.result as ToolResult;
}
const readPost = (file: string) =>
  shim("AfterTool", {
    tool_name: "read_file",
    tool_input: { file_path: join(repo, file) },
    tool_response: { llmContent: "…", returnDisplay: "" },
  });

describe("gemini-cli through the shim", () => {
  test("large tool output is archived and searchable, never replaced", async () => {
    expect(await shim("SessionStart", { source: "startup" })).toBeNull();
    expect(await shim("BeforeAgent", { prompt: "make the zanzibar tests pass" })).toBeNull();
    const out = Array.from({ length: 2000 }, (_, i) => `PASS zanzibar case ${i}`).join("\n");
    const r = await shim("AfterTool", {
      tool_name: "run_shell_command",
      tool_input: { command: "npm test" },
      tool_response: { llmContent: out, returnDisplay: out },
    });
    expect(r).toBeNull();
    await daemon.ctx.queue.drain();
    expect((await tool("sieve_search", { query: "zanzibar case 1234" })).content).toContain(
      "run_shell_command: npm test",
    );
  });

  test("a large file read gets an outline (denied once with the reason)", async () => {
    await shim("BeforeAgent", { prompt: "where is handler417 rate limited?" });
    // The watcher indexes the repo in the background; smart reads use that index.
    for (let i = 0; i < 250; i++) {
      const w = daemon.status().watchers.find((x) => x.worktree === realpathSync(repo));
      if ((w?.symbols ?? 0) >= 600) break;
      await Bun.sleep(40);
    }
    const r = await shim("BeforeTool", {
      tool_name: "read_file",
      tool_input: { file_path: join(repo, "src/routes.ts") },
    });
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("src/routes.ts: 1,800 lines");
    expect(r.reason).toContain("Call read_file with start_line 1252 and end_line 1254");
  });

  test("no 'unchanged since your read' for Gemini: its compaction cannot be detected reliably", async () => {
    await readPost("src/small.ts");
    expect(
      await shim("BeforeTool", {
        tool_name: "read_file",
        tool_input: { file_path: join(repo, "src/small.ts") },
      }),
    ).toBeNull();
  });

  test("an automatic PreCompress (fired every turn) changes nothing; a manual one delivers the state next prompt", async () => {
    const { store } = daemon.ctx.project(repo);
    const epoch = store.epoch("G");
    expect(await shim("PreCompress", { trigger: "auto" })).toBeNull();
    expect(store.epoch("G")).toBe(epoch);
    expect(
      (await shim("BeforeAgent", { prompt: "next" }))?.hookSpecificOutput?.additionalContext ?? "",
    ).not.toContain("[sieve state]");
    await shim("AfterAgent", { prompt: "next", prompt_response: "ok" });
    expect(await shim("PreCompress", { trigger: "manual" })).toBeNull();
    expect(store.epoch("G")).toBe(epoch + 1);
    const ctx = (await shim("BeforeAgent", { prompt: "go on" }))?.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).toContain("[sieve state]");
    expect(ctx).toContain("goal (#1): make the zanzibar tests pass");
  });

  test("ask_user answers become decisions; write_todos become next steps", async () => {
    await shim("AfterTool", {
      tool_name: "ask_user",
      tool_input: { questions: [{ question: "Which test runner should we keep?", header: "Runner" }] },
      tool_response: { llmContent: JSON.stringify({ answers: { "0": "vitest" } }), returnDisplay: "" },
    });
    await shim("AfterTool", {
      tool_name: "write_todos",
      tool_input: { todos: [{ description: "Fix zanzibar case 7", status: "in_progress" }] },
      tool_response: { llmContent: "ok", returnDisplay: "" },
    });
    const s = (await tool("sieve_resume", {})).content;
    expect(s).toContain("- Runner: vitest (#");
    expect(s).toContain("- [in progress] Fix zanzibar case 7");
  });

  test("hooks record under gemini-cli in status", () => {
    const a = daemon.status().agents.find((x) => x.agent === "gemini-cli");
    expect(a?.events.map((e) => e.event)).toContain("BeforeAgent");
  });
});
