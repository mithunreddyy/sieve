import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toEvent as claudeToEvent } from "@sieve/adapter-claude-code";
import { applySetup, restoreBackup } from "@sieve/adapter-kit";
import { planSetup, render, setupSpec, toEvent, toolRef, verifySetup } from "../src/index.ts";

const ev = (name: string, extra: Record<string, unknown>) =>
  toEvent(name, { conversation_id: "c1", generation_id: "g", model: "m", cwd: "/w", ...extra }, 1);

describe("cursor events (payloads from Cursor Agent CLI 2026.04.28)", () => {
  test("postToolUse carries tool_output as text; postToolUseFailure is an error", () => {
    expect(
      ev("postToolUse", {
        tool_name: "Shell",
        tool_input: { command: "ls" },
        tool_output: "a\nb",
        duration: 3,
      }),
    ).toMatchObject({
      kind: "tool.after",
      tool: { family: "shell" },
      output: { text: "a\nb", isError: false },
    });
    expect(
      ev("postToolUseFailure", {
        tool_name: "Shell",
        tool_input: {},
        error_message: "boom",
        failure_type: "x",
      }),
    ).toMatchObject({
      output: { text: "boom", isError: true },
    });
    expect(toolRef("MCP:sieve_sieve_run")).toMatchObject({ family: "mcp", server: "sieve" });
  });
  test("session id is the conversation; cwd from cwd or the first workspace root", () => {
    expect(
      toEvent("beforeSubmitPrompt", { conversation_id: "c9", workspace_roots: ["/ws"], prompt: "hi" }, 1),
    ).toMatchObject({
      base: { sessionId: "c9", cwd: "/ws" },
      prompt: "hi",
    });
    expect(toEvent("stop", { generation_id: "g" }, 1)).toBeNull();
    expect(ev("preCompact", { trigger: "manual", messages_to_compact: 4 })).toMatchObject({
      trigger: "manual",
    });
  });
  test("render: deny with agent_message; context only where Cursor accepts it", () => {
    const pre = ev("preToolUse", { tool_name: "Read", tool_input: { path: "/a" } })!;
    expect(JSON.parse(render(pre, { decision: { action: "deny", reason: "outline" } }, {}))).toMatchObject({
      permission: "deny",
      agent_message: "outline",
    });
    expect(
      JSON.parse(render(ev("postToolUse", { tool_name: "Shell", tool_output: "x" })!, { context: "c" }, {})),
    ).toEqual({
      additional_context: "c",
    });
    expect(JSON.parse(render(ev("sessionStart", {})!, { context: "c" }, {}))).toEqual({
      additional_context: "c",
    });
    expect(render(ev("beforeSubmitPrompt", { prompt: "p" })!, { context: "c" }, {})).toBe(""); // no slot
    expect(
      render(ev("postToolUse", { tool_name: "Shell", tool_output: "x" })!, { replaceOutput: "r" }, {}),
    ).toBe("");
  });
  test("the Claude Code adapter ignores a Cursor-shaped payload", () => {
    expect(
      claudeToEvent("PostToolUse", { conversation_id: "c1", tool_name: "Shell", tool_output: "x" }, 1),
    ).toBeNull();
    expect(
      claudeToEvent("PostToolUse", { session_id: "s", tool_name: "Bash", tool_response: {} }, 1),
    ).not.toBeNull();
  });
});

function sandbox(hooks?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "sieve-cu-"));
  const configDir = join(dir, ".cursor");
  mkdirSync(configDir);
  mkdirSync(join(dir, "bin"));
  const shimPath = join(dir, "bin", "sieve-hook");
  const sievePath = join(dir, "bin", "sieve");
  for (const f of [shimPath, sievePath]) {
    writeFileSync(f, "#!/bin/sh\n");
    chmodSync(f, 0o755);
  }
  if (hooks) writeFileSync(join(configDir, "hooks.json"), JSON.stringify(hooks));
  writeFileSync(join(configDir, "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  return { configDir, opts: { configDir, shimPath, sievePath, backupRoot: join(dir, "b") } };
}

describe("cursor setup", () => {
  test("adds hooks.json (version 1) and the MCP server beside the user's; remove restores; hooks.json made by Sieve goes away", () => {
    const s = sandbox();
    const r = applySetup(setupSpec, s.opts);
    expect(r.verified).toBe(true);
    const hooks = JSON.parse(readFileSync(join(s.configDir, "hooks.json"), "utf8"));
    expect(hooks.version).toBe(1);
    expect(hooks.hooks.preToolUse).toEqual([
      { type: "command", command: `${s.opts.shimPath} cursor preToolUse`, timeout: 5 },
    ]);
    expect(Object.keys(hooks.hooks)).toHaveLength(9);
    const mcp = JSON.parse(readFileSync(join(s.configDir, "mcp.json"), "utf8")).mcpServers;
    expect(mcp.other).toEqual({ command: "x" });
    expect(mcp.sieve).toEqual({ command: s.opts.sievePath, args: ["mcp"] });
    expect(planSetup(s.opts)).toEqual([]);
    applySetup(setupSpec, s.opts, true);
    expect(existsSync(join(s.configDir, "hooks.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(s.configDir, "mcp.json"), "utf8"))).toEqual({
      mcpServers: { other: { command: "x" } },
    });
    expect(restoreBackup(r.backupDir!).length).toBe(1); // mcp.json existed before; hooks.json did not
  });
  test("keeps the user's own hooks", () => {
    const s = sandbox({
      version: 1,
      hooks: { preToolUse: [{ command: "./audit.sh" }], stop: [{ command: "./done.sh" }] },
    });
    applySetup(setupSpec, s.opts);
    const h = JSON.parse(readFileSync(join(s.configDir, "hooks.json"), "utf8")).hooks;
    expect(h.preToolUse.map((e: { command: string }) => e.command)).toEqual([
      "./audit.sh",
      `${s.opts.shimPath} cursor preToolUse`,
    ]);
    applySetup(setupSpec, s.opts, true);
    expect(JSON.parse(readFileSync(join(s.configDir, "hooks.json"), "utf8"))).toEqual({
      version: 1,
      hooks: { preToolUse: [{ command: "./audit.sh" }], stop: [{ command: "./done.sh" }] },
    });
    expect(verifySetup(s.opts).length).toBeGreaterThan(0);
  });
});
