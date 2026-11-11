import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SievePlugin } from "../../adapters/opencode/plugin/sieve.ts";
import { Daemon } from "../src/index.ts";
import { freshHome } from "./helpers.ts";

/**
 * The real plugin module, loaded the way OpenCode loads it, talking to an in-process daemon
 * over the socket. Inputs follow OpenCode 1.19.4's hook shapes.
 */
let env: ReturnType<typeof freshHome>;
let daemon: Daemon;
let repo: string;
let hooks: Awaited<ReturnType<typeof SievePlugin>>;

beforeAll(async () => {
  env = freshHome();
  process.env.SIEVE_HOOK_TIMEOUT_MS = "2000";
  repo = join(env.home, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "small.ts"), "export const port = 8080;\n");
  daemon = new Daemon({ idleMinutes: 0, log: () => {} });
  expect(await daemon.start()).toBe(true);
  hooks = await SievePlugin({ directory: repo, worktree: repo });
});
afterAll(async () => {
  delete process.env.SIEVE_HOOK_TIMEOUT_MS;
  await daemon.stop();
  env.cleanup();
});

const S = "ses_test";
const after = async (tool: string, args: unknown, output: string, metadata: unknown = {}) => {
  const o = { title: tool, output, metadata };
  await hooks["tool.execute.after"]({ tool, sessionID: S, callID: "c", args }, o);
  return o.output;
};

describe("opencode plugin → daemon", () => {
  test("large bash output is replaced in place by a receipt", async () => {
    await hooks.event({
      event: { type: "session.created", properties: { info: { id: S, directory: repo } } },
    });
    const big = Array.from(
      { length: 3000 },
      (_, i) => `PASS src/feature${i}/widget.test.ts (${i % 97} ms)`,
    ).join("\n");
    const out = await after("bash", { command: "npm test", description: "run tests" }, big, { exit: 0 });
    expect(out).toMatch(/^\[sieve s_[a-z2-7]+\]/);
    expect(out).toContain("Do not re-run the command");
  });

  test("small output and errors stay as they are", async () => {
    expect(await after("bash", { command: "ls" }, "a\nb\n", { exit: 0 })).toBe("a\nb\n");
  });

  test("context goes in as one synthetic text part with an OpenCode-style ascending id", async () => {
    // Make a recall pointer possible: an earlier session's failing output naming the file.
    await hooks["tool.execute.after"](
      { tool: "bash", sessionID: "ses_old", callID: "c", args: { command: "bun test" } },
      {
        title: "",
        output: `FAIL small.test.ts\nError: port should be 9090 in small.ts\n${"x\n".repeat(600)}`,
        metadata: { exit: 1 },
      },
    );
    await daemon.ctx.queue.drain();
    const output = {
      message: { id: "msg_1" },
      parts: [{ id: "prt_0001", type: "text", text: "why does small.ts use port 8080?" }] as Array<
        Record<string, unknown>
      >,
    };
    await hooks["chat.message"]({ sessionID: S }, output);
    expect(output.parts).toHaveLength(2);
    const p = output.parts[1]!;
    expect(p).toMatchObject({ type: "text", synthetic: true, sessionID: S, messageID: "msg_1" });
    expect(p.id as string).toMatch(/^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(p.text as string).toContain("[sieve] Earlier output matching this request");
  });

  test("a re-read of an unchanged file is declined by throwing, once", async () => {
    const f = join(repo, "small.ts");
    await after(
      "read",
      { filePath: f },
      `<content>\n1: export const port = 8080;\n\n(End of file - total 1 lines)\n</content>`,
    );
    await expect(
      hooks["tool.execute.before"]({ tool: "read", sessionID: S, callID: "c" }, { args: { filePath: f } }),
    ).rejects.toThrow("unchanged since your read #1");
    // Asked again: it goes through.
    await hooks["tool.execute.before"](
      { tool: "read", sessionID: S, callID: "c" },
      { args: { filePath: f } },
    );
  });

  test("compaction: the state block is added to the compaction context, and is a reset", async () => {
    await after(
      "todowrite",
      { todos: [{ content: "Switch to port 9090", status: "in_progress", priority: "high", id: "1" }] },
      "[]",
    );
    const { store } = daemon.ctx.project(repo);
    const epoch = store.epoch(S);
    const out = { context: [] as string[] };
    await hooks["experimental.session.compacting"]({ sessionID: S }, out);
    expect(store.epoch(S)).toBe(epoch + 1);
    expect(out.context).toHaveLength(1);
    expect(out.context[0]).toContain("[sieve state]");
    expect(out.context[0]).toContain("- [in progress] Switch to port 9090");
  });

  test("question answers become decisions", async () => {
    await after(
      "question",
      { questions: [{ question: "Which port should the server use?", header: "Port", options: [] }] },
      'User has answered your questions: "Which port should the server use?"="9090". You can now continue with the user\'s answers in mind.',
    );
    const { store, ref } = daemon.ctx.project(repo);
    expect(store.log.decisions(ref.worktree).map((d) => `${d.label}: ${d.text}`)).toContain("Port: 9090");
  });

  test("with no daemon (and a missing sieve binary), every hook changes nothing and a miss is logged", async () => {
    await daemon.stop();
    process.env.SIEVE_BIN = "/nonexistent/sieve"; // the spawn fails: that must not throw inside OpenCode
    const o = { title: "", output: "x".repeat(10_000), metadata: {} };
    await hooks["tool.execute.after"](
      { tool: "bash", sessionID: S, callID: "c", args: { command: "ls" } },
      o,
    );
    expect(o.output).toBe("x".repeat(10_000));
    await hooks["tool.execute.before"](
      { tool: "read", sessionID: S, callID: "c" },
      { args: { filePath: "/x" } },
    );
    const misses = join(env.home, "run", "misses.log");
    await Bun.sleep(50); // the failed spawn reports asynchronously
    const log = existsSync(misses) ? readFileSync(misses, "utf8") : "";
    expect(log).toContain("opencode\ttool.execute.after\tdaemon-down");
    expect(log).toContain("opencode\tspawn\tdaemon-start-failed");
    delete process.env.SIEVE_BIN;
  });
});
