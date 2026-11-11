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
  expect(await p.exited).toBe(0);
  return out ? JSON.parse(out) : null;
}
const cu = (event: string, extra: Record<string, unknown>, conv = "C1") =>
  hook("cursor", event, { conversation_id: conv, generation_id: "g", model: "m", cwd: repo, ...extra });
const shell = (cmd: string, out: string) =>
  cu("postToolUse", {
    tool_name: "Shell",
    tool_input: { command: cmd },
    tool_output: out,
    duration: 5,
    tool_use_id: "t",
  });

describe("cursor through the shim", () => {
  test("large output is archived, never replaced; failures reach the session log", async () => {
    expect(await cu("sessionStart", {})).toBeNull();
    expect(await cu("beforeSubmitPrompt", { prompt: "make the zanzibar tests pass" })).toBeNull();
    const out = Array.from({ length: 2000 }, (_, i) => `PASS zanzibar ${i}`).join("\n");
    expect(await shell("npm test", out)).toBeNull();
    await cu("postToolUseFailure", {
      tool_name: "Shell",
      tool_input: { command: "npm run build" },
      error_message: "Error: build failed",
    });
    await daemon.ctx.queue.drain();
    const { store } = daemon.ctx.project(repo);
    expect(store.log.rows("C1").map((r) => r.kind)).toEqual(["prompt", "command", "command", "error"]);
  });

  test("notes made at a prompt wait for the next tool result", async () => {
    const { store } = daemon.ctx.project(repo);
    await shell("cat limiter.ts", "export const x = 1;\n"); // gives the file a read to go stale
    await cu("postToolUse", {
      tool_name: "Read",
      tool_input: { path: join(repo, "limiter.ts") },
      tool_output: "export const x = 1;",
      tool_use_id: "r",
    });
    writeFileSync(join(repo, "limiter.ts"), "export const x = 2;\n"); // changed by someone else
    const atPrompt = await cu("beforeSubmitPrompt", { prompt: "carry on" });
    expect(atPrompt).toBeNull(); // Cursor has no context slot here
    const next = await shell("ls", "a\n");
    expect(next?.additional_context).toContain("limiter.ts (changed");
    expect(await shell("ls", "a\n")).toBeNull(); // delivered once
    expect(store.epoch("C1")).toBe(0);
  });

  test("compaction: the state block rides on the next tool result, after the next prompt", async () => {
    expect(
      await cu("preCompact", { trigger: "auto", context_usage_percent: 91, messages_to_compact: 40 }),
    ).toBeNull();
    expect(await cu("beforeSubmitPrompt", { prompt: "go on" })).toBeNull();
    const r = await shell("pwd", "/w\n");
    expect(r?.additional_context).toContain("[sieve state]");
    expect(r?.additional_context).toContain("goal (#1): make the zanzibar tests pass");
    expect(r?.additional_context).toContain("npm run build: Error: build failed");
  });

  test("a read of an unchanged file is declined with agent_message once", async () => {
    await cu("postToolUse", {
      tool_name: "Read",
      tool_input: { path: join(repo, "limiter.ts") },
      tool_output: "export const x = 2;",
      tool_use_id: "r2",
    });
    const d = await cu("preToolUse", {
      tool_name: "Read",
      tool_input: { path: join(repo, "limiter.ts") },
      tool_use_id: "r3",
    });
    // Cursor does not report whether a read was whole, so it counts as partial: no "unchanged" claim.
    expect(d).toBeNull();
  });

  test("hooks record under cursor; a Cursor payload sent to the claude-code adapter is ignored", async () => {
    expect(
      daemon
        .status()
        .agents.find((a) => a.agent === "cursor")
        ?.events.map((e) => e.event),
    ).toContain("preCompact");
    const before = daemon.status().agents.find((a) => a.agent === "claude-code");
    expect(
      await hook("claude-code", "PostToolUse", {
        conversation_id: "C1",
        tool_name: "Shell",
        tool_output: "x".repeat(9000),
      }),
    ).toBeNull();
    expect(daemon.status().agents.find((a) => a.agent === "claude-code")).toEqual(before);
  });
});
