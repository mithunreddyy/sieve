import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySetup, restoreBackup } from "@sieve/adapter-kit";
import {
  answeredQuestions,
  approvedPlan,
  planSetup,
  readRequest,
  readWasWhole,
  render,
  setupSpec,
  todoList,
  toEvent,
  verifySetup,
} from "../src/index.ts";

const ev = (name: string, extra: Record<string, unknown>) =>
  toEvent(name, { session_id: "g1", cwd: "/w", hook_event_name: name, timestamp: "x", ...extra }, 1);

describe("gemini-cli events (shapes from Gemini CLI 0.65.0)", () => {
  test("AfterTool: llmContent as a string or parts; error flag; MCP server from mcp_context", () => {
    const a = ev("AfterTool", {
      tool_name: "run_shell_command",
      tool_input: { command: "npm test" },
      tool_response: { llmContent: "out", returnDisplay: "out" },
    });
    expect(a).toMatchObject({
      kind: "tool.after",
      tool: { family: "shell" },
      output: { text: "out", isError: false },
    });
    const b = ev("AfterTool", {
      tool_name: "mcp_sieve_sieve_run",
      mcp_context: { server_name: "sieve", tool_name: "sieve_run" },
      tool_input: {},
      tool_response: { llmContent: [{ text: "a" }, { text: "b" }], error: { message: "x" } },
    });
    expect(b).toMatchObject({
      tool: { family: "mcp", server: "sieve" },
      output: { text: "a\nb", isError: true },
    });
  });

  test("lifecycle: SessionStart sources, BeforeAgent prompt, PreCompress trigger", () => {
    expect(ev("SessionStart", { source: "clear" })).toMatchObject({ kind: "session.start", source: "clear" });
    expect(ev("BeforeAgent", { prompt: "hi" })).toMatchObject({ kind: "prompt.submit", prompt: "hi" });
    expect(ev("PreCompress", { trigger: "manual" })).toMatchObject({
      kind: "compact.before",
      trigger: "manual",
    });
    expect(ev("AfterAgent", { prompt: "x", prompt_response: "y" })).toMatchObject({ kind: "turn.end" });
    expect(ev("Notification", {})).toBeNull();
  });

  test("render: deny with reason before a tool; context on prompts; never a replacement after a tool", () => {
    const before = ev("BeforeTool", { tool_name: "read_file", tool_input: { file_path: "a" } })!;
    expect(JSON.parse(render(before, { decision: { action: "deny", reason: "outline…" } }, {}))).toEqual({
      decision: "deny",
      reason: "outline…",
    });
    const p = ev("BeforeAgent", { prompt: "x" })!;
    expect(JSON.parse(render(p, { context: "ctx" }, {}))).toEqual({
      hookSpecificOutput: { hookEventName: "BeforeAgent", additionalContext: "ctx" },
    });
    const after = ev("AfterTool", { tool_name: "run_shell_command", tool_input: {}, tool_response: {} })!;
    // A Gemini "deny" here would reach the model as "Tool result blocked: …", a failed call.
    expect(render(after, { replaceOutput: "receipt", context: "c" }, {})).toBe("");
    expect(render(p, {}, {})).toBe("");
  });

  test("reads, decisions, todos, plans", () => {
    expect(readRequest({ file_path: "a.ts" })).toEqual({ path: "a.ts", full: true });
    expect(readRequest({ file_path: "a.ts", start_line: 10 })).toEqual({ path: "a.ts", full: false });
    expect(readWasWhole({ llmContent: "abc" })).toBe(true);
    expect(readWasWhole({ llmContent: "\nIMPORTANT: The file content has been truncated.\nStatus: …" })).toBe(
      false,
    );
    expect(
      answeredQuestions(
        "ask_user",
        { questions: [{ question: "Which store?", header: "Storage" }, { question: "Unanswered?" }] },
        { llmContent: JSON.stringify({ answers: { "0": "Redis" } }) },
      ),
    ).toEqual([{ header: "Storage", question: "Which store?", answer: "Redis" }]);
    expect(answeredQuestions("ask_user", { questions: [] }, { llmContent: "not json" })).toEqual([]);
    expect(
      todoList("write_todos", {
        todos: [
          { description: "a", status: "completed" },
          { description: "b", status: "cancelled" },
        ],
      }),
    ).toEqual([
      { content: "a", status: "completed" },
      { content: "b", status: "cancelled" },
    ]);
    expect(approvedPlan("exit_plan_mode", { plan_filename: "limiter.md" }, { llmContent: "ok" })).toContain(
      "limiter.md",
    );
    expect(
      approvedPlan("exit_plan_mode", { plan_filename: "x.md" }, { llmContent: "no", error: {} }),
    ).toBeNull();
  });
});

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "sieve-gm-"));
  mkdirSync(join(dir, ".gemini"));
  mkdirSync(join(dir, "bin"));
  const shimPath = join(dir, "bin", "sieve-hook");
  const sievePath = join(dir, "bin", "sieve");
  for (const f of [shimPath, sievePath]) {
    writeFileSync(f, "#!/bin/sh\n");
    chmodSync(f, 0o755);
  }
  const settingsFile = join(dir, ".gemini", "settings.json");
  const user = {
    theme: "Dracula",
    hooks: { BeforeTool: [{ matcher: "write_file", hooks: [{ type: "command", command: "./lint.sh" }] }] },
    mcpServers: { other: { command: "x" } },
  };
  const text = `${JSON.stringify(user, null, 4)}\n`;
  writeFileSync(settingsFile, text);
  return {
    dir,
    settingsFile,
    text,
    opts: { home: dir, shimPath, sievePath, backupRoot: join(dir, "backups") },
  };
}

describe("gemini-cli setup", () => {
  test("adds Sieve's hooks and MCP server next to the user's; twice changes nothing; remove restores", () => {
    const s = sandbox();
    const plan = planSetup(s.opts);
    expect(plan).toHaveLength(1);
    const r = applySetup(setupSpec, s.opts);
    expect(r.verified).toBe(true);
    const after = JSON.parse(readFileSync(s.settingsFile, "utf8"));
    expect(after.theme).toBe("Dracula");
    expect(after.mcpServers.other).toEqual({ command: "x" });
    expect(after.mcpServers.sieve).toEqual({ command: s.opts.sievePath, args: ["mcp"] });
    expect(after.hooks.BeforeTool).toHaveLength(2);
    expect(after.hooks.BeforeTool[0].hooks[0].command).toBe("./lint.sh");
    expect(after.hooks.BeforeTool[1]).toEqual({
      matcher: ".*",
      hooks: [
        {
          name: "sieve",
          type: "command",
          command: `${s.opts.shimPath} gemini-cli BeforeTool`,
          timeout: 5000,
        },
      ],
    });
    expect(Object.keys(after.hooks).sort()).toEqual(
      [
        "AfterAgent",
        "AfterTool",
        "BeforeAgent",
        "BeforeTool",
        "PreCompress",
        "SessionEnd",
        "SessionStart",
      ].sort(),
    );
    expect(planSetup(s.opts)).toEqual([]);
    applySetup(setupSpec, s.opts, true);
    expect(JSON.parse(readFileSync(s.settingsFile, "utf8"))).toEqual(JSON.parse(s.text));
    expect(restoreBackup(r.backupDir!)).toEqual([s.settingsFile]);
    expect(readFileSync(s.settingsFile, "utf8")).toBe(s.text);
  });

  test("verify reports hooks turned off and a missing shim", () => {
    const s = sandbox();
    applySetup(setupSpec, s.opts);
    const cur = JSON.parse(readFileSync(s.settingsFile, "utf8"));
    writeFileSync(s.settingsFile, JSON.stringify({ ...cur, hooksConfig: { enabled: false } }));
    expect(verifySetup(s.opts)).toEqual([
      `hooks are turned off (hooksConfig.enabled = false in ${s.settingsFile})`,
    ]);
    expect(verifySetup({ ...s.opts, shimPath: "/nope" })).toContain("shim not found at /nope");
  });
});

describe("backups never overwrite each other", () => {
  test("setup then remove within one millisecond keep both backups; the first restores the original", () => {
    const s = sandbox();
    const now = new Date("2026-11-11T00:00:00.000Z");
    const a = applySetup(setupSpec, { ...s.opts, now });
    const b = applySetup(setupSpec, { ...s.opts, now }, true);
    expect(a.backupDir).not.toBe(b.backupDir);
    restoreBackup(a.backupDir!);
    expect(readFileSync(s.settingsFile, "utf8")).toBe(s.text);
  });
});
