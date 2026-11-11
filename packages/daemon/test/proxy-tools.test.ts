import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PROXY_PROJECT, ProjectStore } from "@sieve/core";
import { PROTOCOL_VERSION, type ToolResult } from "@sieve/protocol";
import { Daemon } from "../src/index.ts";
import { freshHome } from "./helpers.ts";

let env: ReturnType<typeof freshHome>;
let daemon: Daemon;
let repo: string;

beforeAll(async () => {
  env = freshHome();
  repo = join(env.home, "repo");
  mkdirSync(repo, { recursive: true });
  daemon = new Daemon({ idleMinutes: 0, log: () => {} });
  expect(await daemon.start()).toBe(true);
});
afterAll(async () => {
  await daemon.stop();
  env.cleanup();
});

async function tool(name: string, args: unknown): Promise<ToolResult> {
  const r = await daemon.handleLine(
    JSON.stringify({ v: PROTOCOL_VERSION, id: "t", type: "tool", tool: name, args, cwd: repo }),
  );
  if (!r.ok) throw new Error(r.error.message);
  return r.result as ToolResult;
}

describe("sieve_schema", () => {
  test("says plainly that nothing has been trimmed when the proxy has not run", async () => {
    const r = await tool("sieve_schema", { tool: "ghost" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("it has not trimmed any yet");
  });

  test("returns the full stored definition, and lists known names for a miss", async () => {
    const def = {
      name: "big",
      description: "The whole long description.",
      input_schema: { type: "object", required: ["a"] },
    };
    daemon.ctx.global.db.run(
      "INSERT INTO proxy_schemas (name, hash, definition, seen_at) VALUES (?, 'h', ?, 1)",
      ["big", JSON.stringify(def)],
    );
    const r = await tool("sieve_schema", { tool: "big" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content)).toEqual(def);
    const miss = await tool("sieve_schema", { tool: "other" });
    expect(miss.content).toContain("it has trimmed: big");
    await expect(tool("sieve_schema", { tool: "x", extra: 1 })).rejects.toThrow(/extra/);
  });
});

describe("sieve_get for what the proxy archived", () => {
  test("an id that only the proxy's archive holds is still expandable", async () => {
    const text = `proxied output\n${"line\n".repeat(50)}`;
    const ps = new ProjectStore(PROXY_PROJECT);
    const id = ps.put(text, { sessionId: "proxy", worktree: "", sourceKind: "tool", source: "proxy" }).id;
    ps.db.close();
    const r = await tool("sieve_get", { id });
    expect(r.isError).toBe(false);
    expect(r.content).toBe(text);
    const part = await tool("sieve_get", { id, lines: "1-2" });
    expect(part.content).toBe("proxied output\nline");
  });

  test("an unknown id still fails with the usual message", async () => {
    const r = await tool("sieve_get", { id: "s_zzzzzzzz" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Unknown id");
  });
});
