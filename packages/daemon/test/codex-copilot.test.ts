import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Daemon } from "../src/index.ts";
import { freshHome, SHIM } from "./helpers.ts";

let env: ReturnType<typeof freshHome>;
let daemon: Daemon;
let repo: string;

beforeAll(async () => {
  env = freshHome();
  repo = join(env.home, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "limiter.ts"), "export const x = 1;\n");
  daemon = new Daemon({ idleMinutes: 0, log: () => {} });
  expect(await daemon.start()).toBe(true);
});
afterAll(async () => {
  await daemon.stop();
  env.cleanup();
});

async function hook(agent: string, event: string, payload: Record<string, unknown>) {
  const p = Bun.spawn([SHIM, agent, event], {
    stdin: Buffer.from(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const out = await new Response(p.stdout).text();
  expect(await new Response(p.stderr).text()).toBe("");
  expect(await p.exited).toBe(0);
  return out ? JSON.parse(out) : null;
}
const big = Array.from({ length: 2500 }, (_, i) => `PASS case ${i} zanzibar`).join("\n");

describe("codex through the shim", () => {
  const cx = (event: string, extra: Record<string, unknown>) =>
    hook("codex", event, {
      session_id: "X1",
      cwd: repo,
      hook_event_name: event,
      model: "m",
      transcript_path: null,
      ...extra,
    });
  test("log, state after compaction via SessionStart(compact), and no replacement of results", async () => {
    expect(await cx("SessionStart", { source: "startup" })).toBeNull();
    expect(await cx("UserPromptSubmit", { turn_id: "t", prompt: "make the zanzibar tests pass" })).toBeNull();
    expect(
      await cx("PostToolUse", {
        tool_name: "Bash",
        tool_use_id: "u",
        tool_input: { command: "npm test" },
        tool_response: { stdout: big, stderr: "", exit_code: 0 },
      }),
    ).toBeNull();
    await cx("PostToolUse", {
      tool_name: "apply_patch",
      tool_use_id: "u2",
      tool_input: { command: "*** Begin Patch\n*** Update File: limiter.ts\n@@\n-x\n+y\n*** End Patch" },
      tool_response: "ok",
    });
    await cx("PostToolUse", {
      tool_name: "Bash",
      tool_use_id: "u3",
      tool_input: { command: "npm run build" },
      tool_response: { stdout: "", stderr: "Error: build failed", exit_code: 1 },
    });
    await cx("Stop", { turn_id: "t", stop_hook_active: false, last_assistant_message: null });
    await daemon.ctx.queue.drain();
    expect(await cx("PreCompact", { trigger: "auto" })).toBeNull();
    const out = await cx("SessionStart", { source: "compact" });
    const ctx = out.hookSpecificOutput.additionalContext as string;
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(ctx).toContain("goal and last request (#1): make the zanzibar tests pass");
    expect(ctx).toContain("files changed: limiter.ts");
    expect(ctx).toContain("npm run build: Error: build failed");
  });
  test("an automatic compaction is a reset: the epoch moves", () => {
    const { store } = daemon.ctx.project(repo);
    expect(store.epoch("X1")).toBe(2); // PreCompact, then SessionStart(compact)
  });
});

describe("copilot-cli through the shim", () => {
  const cp = (event: string, extra: Record<string, unknown>) =>
    hook("copilot-cli", event, { sessionId: "P1", timestamp: Date.now(), cwd: repo, ...extra });
  const bash = (command: string, text: string, resultType = "success") =>
    cp("postToolUse", {
      toolName: "bash",
      toolArgs: JSON.stringify({ command }),
      toolResult: { resultType, textResultForLlm: text },
    });

  test("large output is really replaced (modifiedResult), and the receipt expands", async () => {
    expect(await cp("sessionStart", { source: "new" })).toBeNull();
    expect(await cp("userPromptSubmitted", { prompt: "make the zanzibar tests pass" })).toBeNull();
    const r = await bash("npm test", big);
    expect(r.modifiedResult.resultType).toBe("success");
    expect(r.modifiedResult.textResultForLlm).toMatch(/^\[sieve s_[a-z2-7]+\]/);
    const id = /\[sieve (s_[a-z2-7]+)\]/.exec(r.modifiedResult.textResultForLlm)![1]!;
    const { store } = daemon.ctx.project(repo);
    expect(store.get(id)?.text).toBe(big);
  });
  test("notes made at a prompt (no context slot) ride on the next postToolUse", async () => {
    await bash("cat limiter.ts", "export const x = 1;\n");
    await cp("postToolUse", {
      toolName: "view",
      toolArgs: JSON.stringify({ path: join(repo, "limiter.ts") }),
      toolResult: { resultType: "success", textResultForLlm: "export const x = 1;" },
    });
    writeFileSync(join(repo, "limiter.ts"), "export const x = 2;\n");
    expect(await cp("userPromptSubmitted", { prompt: "carry on" })).toBeNull();
    const next = await bash("ls", "a\n");
    expect(next.additionalContext).toContain("limiter.ts (changed");
    expect(await bash("ls", "a\n")).toBeNull();
  });
  test("compaction: state block waits for the next tool result", async () => {
    await bash("npm run build", "Error: build failed", "failure");
    await cp("agentStop", { transcriptPath: "/t", stopReason: "end_turn", stop_hook_active: false });
    await daemon.ctx.queue.drain();
    expect(
      await cp("preCompact", { trigger: "auto", transcriptPath: "/t", customInstructions: "" }),
    ).toBeNull();
    expect(await cp("userPromptSubmitted", { prompt: "go on" })).toBeNull();
    const r = await bash("pwd", "/w\n");
    expect(r.additionalContext).toContain("[sieve state]");
    expect(r.additionalContext).toContain("goal (#1): make the zanzibar tests pass");
  });
  test("preToolUse says nothing for an ordinary call (it is fail-closed in Copilot)", async () => {
    expect(
      await cp("preToolUse", { toolName: "bash", toolArgs: JSON.stringify({ command: "ls" }) }),
    ).toBeNull();
  });
});
