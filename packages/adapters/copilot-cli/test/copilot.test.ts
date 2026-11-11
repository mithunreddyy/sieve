import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySetup } from "@sieve/adapter-kit";
import { parseArgs, planSetup, readRequest, render, setupSpec, toEvent, toolRef } from "../src/index.ts";

const ev = (name: string, extra: Record<string, unknown>) =>
  toEvent(name, { sessionId: "p1", timestamp: 1, cwd: "/w", ...extra }, 1);

describe("copilot-cli events (from GitHub's hooks reference)", () => {
  test("toolArgs may be a JSON string or an object; postToolUse text and result type", () => {
    expect(parseArgs('{"command":"ls"}')).toEqual({ command: "ls" });
    expect(parseArgs({ command: "ls" })).toEqual({ command: "ls" });
    expect(parseArgs("not json")).toBeNull();
    expect(
      ev("postToolUse", {
        toolName: "bash",
        toolArgs: '{"command":"ls"}',
        toolResult: { resultType: "success", textResultForLlm: "a\nb" },
      }),
    ).toMatchObject({
      tool: { family: "shell" },
      output: { text: "a\nb", isError: false },
    });
    expect(
      ev("postToolUse", {
        toolName: "bash",
        toolArgs: "{}",
        toolResult: { resultType: "failure", textResultForLlm: "no" },
      }),
    ).toMatchObject({ output: { isError: true } });
    expect(ev("postToolUseFailure", { toolName: "bash", toolArgs: "{}", error: "boom" })).toMatchObject({
      output: { text: "boom", isError: true },
    });
    expect(toolRef("sieve_run")).toMatchObject({ family: "mcp", server: "sieve" });
    expect(readRequest('{"path":"/a"}')).toEqual({ path: "/a", full: true });
    expect(readRequest({ path: "/a", view_range: [1, 5] })).toEqual({ path: "/a", full: false });
  });
  test("the event comes from the command's argument; sub-agents are their own readers", () => {
    expect(ev("userPromptSubmitted", { prompt: "hi" })).toMatchObject({
      kind: "prompt.submit",
      prompt: "hi",
      base: { sessionId: "p1", context: "main" },
    });
    expect(ev("preCompact", { trigger: "auto" })).toMatchObject({ kind: "compact.before", trigger: "auto" });
    expect(ev("agentStop", {})).toMatchObject({ kind: "turn.end" });
    expect(ev("preToolUse", { toolName: "bash", toolArgs: "{}", agentId: "a9" })).toMatchObject({
      base: { context: "sub:a9" },
    });
    expect(ev("errorOccurred", {})).toBeNull();
    expect(toEvent("preToolUse", { session_id: "claude-style" }, 1)).toBeNull();
  });
  test("render: modifiedResult is a real replace; context only at sessionStart and after tools", () => {
    const post = ev("postToolUse", {
      toolName: "bash",
      toolArgs: "{}",
      toolResult: { resultType: "success", textResultForLlm: "x" },
    })!;
    expect(JSON.parse(render(post, { replaceOutput: "receipt", context: "c" }, {}))).toEqual({
      modifiedResult: { resultType: "success", textResultForLlm: "receipt" },
      additionalContext: "c",
    });
    expect(
      JSON.parse(
        render(
          ev("preToolUse", { toolName: "view", toolArgs: "{}" })!,
          { decision: { action: "deny", reason: "r" } },
          {},
        ),
      ),
    ).toEqual({
      permissionDecision: "deny",
      permissionDecisionReason: "r",
    });
    expect(JSON.parse(render(ev("sessionStart", { source: "new" })!, { context: "c" }, {}))).toEqual({
      additionalContext: "c",
    });
    expect(render(ev("userPromptSubmitted", { prompt: "p" })!, { context: "c" }, {})).toBe(""); // output is dropped by Copilot
    expect(render(ev("preToolUse", { toolName: "bash", toolArgs: "{}" })!, {}, {})).toBe(""); // preToolUse is fail-closed in Copilot: say nothing, not garbage
  });
});

function sandbox(mcp?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "sieve-cp-"));
  const copilotHome = join(dir, ".copilot");
  mkdirSync(join(copilotHome, "hooks"), { recursive: true });
  mkdirSync(join(dir, "bin"));
  const shimPath = join(dir, "bin", "sieve-hook");
  const sievePath = join(dir, "bin", "sieve");
  for (const f of [shimPath, sievePath]) {
    writeFileSync(f, "#!/bin/sh\n");
    chmodSync(f, 0o755);
  }
  writeFileSync(
    join(copilotHome, "hooks", "mine.json"),
    '{"version":1,"hooks":{"sessionStart":[{"bash":"./mine.sh"}]}}',
  );
  if (mcp) writeFileSync(join(copilotHome, "mcp-config.json"), JSON.stringify(mcp));
  return {
    copilotHome,
    hooks: join(copilotHome, "hooks", "sieve.json"),
    mcp: join(copilotHome, "mcp-config.json"),
    opts: { copilotHome, shimPath, sievePath, backupRoot: join(dir, "b") },
  };
}

describe("copilot-cli setup", () => {
  test("hooks go in their own file, beside the user's; MCP server added to mcp-config.json; remove is clean", () => {
    const s = sandbox({ mcpServers: { other: { type: "local", command: "x" } } });
    const r = applySetup(setupSpec, s.opts);
    expect(r.verified).toBe(true);
    const h = JSON.parse(readFileSync(s.hooks, "utf8"));
    expect(h.version).toBe(1);
    expect(h.hooks.postToolUse).toEqual([
      { type: "command", bash: `${s.opts.shimPath} copilot-cli postToolUse`, cwd: ".", timeoutSec: 5 },
    ]);
    expect(Object.keys(h.hooks)).toHaveLength(9);
    expect(readFileSync(join(s.copilotHome, "hooks", "mine.json"), "utf8")).toContain("./mine.sh");
    const m = JSON.parse(readFileSync(s.mcp, "utf8")).mcpServers;
    expect(m.other).toEqual({ type: "local", command: "x" });
    expect(m.sieve).toEqual({
      type: "local",
      command: s.opts.sievePath,
      args: ["mcp"],
      env: {},
      tools: ["*"],
    });
    expect(planSetup(s.opts)).toEqual([]);
    applySetup(setupSpec, s.opts, true);
    expect(existsSync(s.hooks)).toBe(false);
    expect(JSON.parse(readFileSync(s.mcp, "utf8"))).toEqual({
      mcpServers: { other: { type: "local", command: "x" } },
    });
    expect(existsSync(join(s.copilotHome, "hooks", "mine.json"))).toBe(true);
  });
});

describe("tool arguments arrive as the object they are", () => {
  test("toolArgs sent as a JSON string is parsed in the event, so rules and read checks can see it", () => {
    const e = toEvent(
      "preToolUse",
      { sessionId: "p", cwd: "/w", toolName: "bash", toolArgs: '{"command":"cat .env"}' },
      1,
    );
    expect(e).toMatchObject({ kind: "tool.before", input: { command: "cat .env" } });
    const o = toEvent(
      "preToolUse",
      { sessionId: "p", cwd: "/w", toolName: "bash", toolArgs: { command: "ls" } },
      1,
    );
    expect(o).toMatchObject({ input: { command: "ls" } });
    expect(
      toEvent("preToolUse", { sessionId: "p", cwd: "/w", toolName: "bash", toolArgs: "not json" }, 1),
    ).toMatchObject({ input: "not json" });
  });
});
