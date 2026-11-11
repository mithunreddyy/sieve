import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { archiveId, paths } from "@sieve/core";
import { type HookResult, PROTOCOL_VERSION, type StatusReport, type ToolResult } from "@sieve/protocol";
import { detect } from "@sieve/sandbox";
import { acquireLock, Daemon, DaemonClient } from "../src/index.ts";
import { bashPost, bigOutput, freshHome, runShim } from "./helpers.ts";

let env: ReturnType<typeof freshHome>;
let daemon: Daemon;
let project: string;

beforeAll(async () => {
  env = freshHome();
  project = join(env.home, "proj");
  mkdirSync(project);
  daemon = new Daemon({ idleMinutes: 0, log: () => {} });
  expect(await daemon.start()).toBe(true);
});
afterAll(async () => {
  await daemon.stop();
  env.cleanup();
});

async function frame(f: Record<string, unknown>) {
  return daemon.handleLine(JSON.stringify({ v: PROTOCOL_VERSION, id: "t", ...f }));
}
async function tool(name: string, args: unknown): Promise<ToolResult> {
  const r = await frame({ type: "tool", tool: name, args, cwd: project });
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.result as ToolResult;
}

describe("hook path through the real Go shim", () => {
  test("large Bash output is archived and replaced by a receipt", async () => {
    const out = bigOutput();
    const r = await runShim(bashPost(out, project));
    expect(r.code).toBe(0);
    const reply = JSON.parse(r.stdout);
    const updated = reply.hookSpecificOutput.updatedToolOutput;
    expect(reply.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(updated.stderr).toBe("");
    expect(updated.interrupted).toBe(false);
    expect(updated.stdout).toContain(`[sieve ${archiveId(out)}]`);
    expect(updated.stdout.length).toBeLessThan(out.length / 5);
    // Nothing is lost: the original comes back byte for byte (in 100 KB pages).
    const first = (await tool("sieve_get", { id: archiveId(out) })).content;
    const m =
      /\[sieve\] showing lines 1-(\d+) of (\d+)\. Continue: sieve_get \{"id":"(s_[a-z2-7]+)","lines":"(\d+-\d+)"\}$/.exec(
        first,
      )!;
    expect(m).not.toBeNull();
    const rest = (await tool("sieve_get", { id: m[3]!, lines: m[4]! })).content;
    expect(`${first.slice(0, first.lastIndexOf("\n[sieve]"))}\n${rest}`).toBe(out);
  });

  test("the same output gives byte-identical receipts (cache-safe)", async () => {
    const out = bigOutput(2500);
    const a = (await runShim(bashPost(out, project))).stdout;
    const b = (await runShim(bashPost(out, project, { session_id: "another-session" }))).stdout;
    expect(a).toBe(b);
  });

  test("small output passes through with no reply", async () => {
    expect((await runShim(bashPost("ok\n", project))).stdout).toBe("");
  });

  test("interrupted (error) output is never cut", async () => {
    const out = bigOutput();
    const r = await runShim(
      bashPost(out, project, { tool_response: { stdout: out, stderr: "", interrupted: true } }),
    );
    if (r.stdout) expect(JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput.stdout).toContain(out);
  });

  test("Sieve's own MCP results and file reads are not folded", async () => {
    const out = bigOutput();
    // Registered by `sieve setup`, and through the Claude Code plugin (tools are then named
    // mcp__plugin_<plugin>_<server>__<tool>): folding sieve_get would make archives unexpandable.
    for (const tool_name of ["mcp__sieve__sieve_get", "mcp__plugin_sieve_sieve__sieve_get"]) {
      const own = { ...bashPost(out, project), tool_name, tool_response: [{ type: "text", text: out }] };
      expect((await runShim(own)).stdout).toBe("");
    }
    const read = {
      ...bashPost(out, project),
      tool_name: "Read",
      tool_input: { file_path: "/x.ts" },
      tool_response: { type: "text", file: { content: out } },
    };
    expect((await runShim(read)).stdout).toBe("");
  });

  test("other MCP tools are folded in their own content shape", async () => {
    const out = bigOutput();
    const r = await runShim({
      ...bashPost(out, project),
      tool_name: "mcp__github__list_issues",
      tool_response: [{ type: "text", text: out }],
    });
    const updated = JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput;
    expect(updated).toHaveLength(1);
    expect(updated[0].text).toContain("[sieve s_");
  });

  test("archived output becomes searchable", async () => {
    const r = await tool("sieve_search", { query: "feature1234 widget" });
    expect(r.content).toContain("feature1234");
    expect(r.content).toContain(archiveId(bigOutput()));
  });

  test("hook health is recorded per agent and event", async () => {
    await runShim(
      { session_id: "sess-1", cwd: project, hook_event_name: "SessionStart", source: "startup" },
      {},
      "SessionStart",
    );
    const r = await frame({ type: "status" });
    const s = (r as { result: StatusReport }).result;
    const cc = s.agents.find((a) => a.agent === "claude-code")!;
    expect(cc.events.map((e) => e.event)).toEqual(expect.arrayContaining(["PostToolUse", "SessionStart"]));
    expect(cc.latencyMs.count).toBeGreaterThan(0);
  });
});

describe("extractors on the hook path", () => {
  test("real vitest output gets a vitest receipt with the failures intact", async () => {
    const out = readFileSync(
      join(import.meta.dir, "../../core/fixtures/vitest/verbose-two-failures.txt"),
      "utf8",
    );
    const r = await runShim(
      bashPost(out, project, {
        tool_input: { command: "npx vitest run --reporter=verbose", description: "Run tests" },
      }),
    );
    const text = JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput.stdout as string;
    expect(text).toContain("extractor: vitest");
    expect(text).toContain("AssertionError: expected 81 to be 90");
    expect(text).toContain("passing test");
  });
  test("Grep tool output is grouped by file", async () => {
    const out = readFileSync(join(import.meta.dir, "../../core/fixtures/search/rg-many.txt"), "utf8");
    const r = await runShim({
      ...bashPost(out, project),
      tool_name: "Grep",
      tool_input: { pattern: "subprocess", output_mode: "content" },
      tool_response: { mode: "content", content: out },
    });
    const reply = r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput : null;
    expect(JSON.stringify(reply)).toContain("extractor: search");
  });
});

describe("protocol", () => {
  test("rejects other protocol versions", async () => {
    const r = await daemon.handleLine(JSON.stringify({ v: 99, type: "ping" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("version_mismatch");
  });
  test("rejects unknown tool arguments by name", async () => {
    const r = await frame({ type: "tool", tool: "sieve_get", args: { id: "s_abc", extra: 1 }, cwd: project });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("unknown field(s): extra");
  });
  test("hook for an unknown agent passes through", async () => {
    const r = await frame({ type: "hook", agent: "nope", event: "x", input: {} });
    expect((r as { result: HookResult }).result.stdout).toBe("");
  });
});

describe("sieve_run", () => {
  test("small output is returned whole with the isolation level stated", async () => {
    const r = await tool("sieve_run", {
      language: "shell",
      code: "echo hello; echo $SIEVE_FILE",
      file: "a.txt",
    });
    expect(r.content).toContain("exit 0");
    // Whatever this machine can enforce is what the receipt must say (seatbelt, bwrap, or none).
    expect(r.content).toContain(`isolation: ${detect().kind}`);
    expect(r.content).toContain("hello\na.txt");
  });
  test("output over 16 KB is archived with a preview of at most ~4 KB", async () => {
    const r = await tool("sieve_run", {
      language: "python",
      code: "for i in range(5000): print(f'row {i} value {i*i}')",
      intent: "row 2500",
    });
    expect(r.content).toContain("[sieve s_");
    expect(r.content).toContain("row 2500 value");
    expect(r.content).not.toContain("row 2501 value");
    expect(Buffer.byteLength(r.content)).toBeLessThan(4096 + 600); // preview ≤ 4 KB + header/footer
    const id = /\[sieve (s_[a-z2-7]+)\]/.exec(r.content)![1]!;
    const full = await tool("sieve_get", { id, lines: "4999-5000" });
    expect(full.content).toBe("row 4998 value 24980004\nrow 4999 value 24990001");
  });
  test("JS runs on Sieve's own Bun", async () => {
    const r = await tool("sieve_run", { language: "ts", code: "const n: number = 6 * 7; console.log(n)" });
    expect(r.content).toContain("42");
  });
  test("timeout kills the whole process tree", async () => {
    const marker = join(env.home, "grandchild-alive");
    const t0 = Date.now();
    const r = await tool("sieve_run", {
      language: "shell",
      code: `(sleep 2; touch ${marker}) & sleep 30`,
      timeoutMs: 300,
    });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.content).toContain("timed out");
    await Bun.sleep(2500);
    expect(existsSync(marker)).toBe(false);
  });
  test("background runs return a handle that sieve_get polls", async () => {
    const r = await tool("sieve_run", {
      language: "shell",
      code: "sleep 0.3; echo finished",
      background: true,
    });
    const id = /(j_[a-z2-7]+)/.exec(r.content)![1]!;
    expect((await tool("sieve_get", { id })).content).toContain("still running");
    await Bun.sleep(800);
    expect((await tool("sieve_get", { id })).content).toContain("finished");
  });
  test("non-zero exit is reported", async () => {
    const r = await tool("sieve_run", { language: "shell", code: "echo bad >&2; exit 3" });
    expect(r.content).toContain("exit 3");
    expect(r.content).toContain("bad");
  });
});

describe("sieve_batch", () => {
  test("runs commands in order and answers queries from their output only", async () => {
    const r = await tool("sieve_batch", {
      commands: [
        "printf 'db host: pg-primary.internal\\nretries: 3\\n'",
        "seq 1 3000 | sed 's/^/row /'",
        "echo third",
      ],
      queries: ["database host", "retreis"],
    });
    expect(r.content).toContain("[sieve batch] 3 commands");
    expect(r.content).toMatch(/1\. exit 0 .* s_[a-z2-7]+ · printf/);
    expect(r.content).toContain("pg-primary.internal");
    expect(r.content).toContain("(searched for retries)");
    expect(r.content).not.toContain("row 2999");
  });
  test("sieve_run uses an extractor when output is large and recognised", async () => {
    const r = await tool("sieve_run", {
      language: "shell",
      code: "for i in $(seq 1 1500); do echo \"=== RUN   TestX/case_$i\"; done; echo '--- FAIL: TestY (0.00s)'; echo '    y_test.go:9: boom'; echo 'FAIL\texample.com/y\t0.01s'",
    });
    expect(r.content).toContain("extractor: go-test");
    expect(r.content).toContain("y_test.go:9: boom");
  });
});

describe("sieve_index and sieve_stats", () => {
  test("indexes a folder, honouring .gitignore", async () => {
    const dir = join(project, "docs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "guide.md"), "# Guide\n## Deploy\nUse the zebracorn pipeline.\n");
    writeFileSync(join(dir, "secret.log"), "zebracorn-secret");
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    Bun.spawnSync(["git", "init", "-q"], { cwd: project });
    const r = await tool("sieve_index", { path: "docs" });
    expect(r.content).toMatch(/Indexed 2 file/); // guide.md + .gitignore, not secret.log
    const s = await tool("sieve_search", { query: "zebracorn" });
    expect(s.content).toContain("Guide > Deploy");
    expect(s.content).not.toContain("zebracorn-secret");
  });
  test("stats report tokens in and out", async () => {
    const r = await tool("sieve_stats", {});
    expect(r.content).toMatch(/fold\(s\), [\d,]+ tokens in → [\d,]+ returned \(\d+% fewer\)/);
  });
});

describe("lifecycle", () => {
  test("a second daemon refuses to start while the first holds the lock", async () => {
    const d2 = new Daemon({ idleMinutes: 0, log: () => {} });
    expect(await d2.start()).toBe(false);
    d2.ctx.close();
  });
  test("a lock left by a dead process is taken over", () => {
    const lock = join(env.home, "stale.lock");
    writeFileSync(lock, "999999");
    expect(acquireLock(lock)).toBe(true);
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
  });
  test("the maintenance tick checkpoints the WAL (auto-checkpoint is off in the daemon)", async () => {
    const lock = join(env.home, "maint.lock");
    const d = new Daemon({
      idleMinutes: 0,
      maintenanceMs: 20,
      socketPath: join(env.home, "m.sock"),
      lockPath: lock,
      log: () => {},
    });
    let n = 0;
    const orig = d.ctx.checkpointAll.bind(d.ctx);
    d.ctx.checkpointAll = () => {
      n++;
      orig();
    };
    expect(await d.start()).toBe(true);
    await Bun.sleep(200);
    await d.stop();
    expect(n).toBeGreaterThan(0);
  });
  test("a shutdown step that throws still ends the process (found: orphans spinning at 100% CPU)", async () => {
    const d = new Daemon({
      idleMinutes: 0,
      socketPath: join(env.home, "t.sock"),
      lockPath: join(env.home, "t.lock"),
      log: () => {},
    });
    expect(await d.start()).toBe(true);
    const close = d.ctx.close.bind(d.ctx);
    d.ctx.close = () => {
      close();
      throw new Error("disk I/O error"); // what SQLite reports once SIEVE_HOME was deleted
    };
    let stopped = 0;
    d.onStop = () => stopped++;
    await d.stop();
    expect(stopped).toBe(1);
    expect(existsSync(join(env.home, "t.lock"))).toBe(false);
  });
  test("the daemon stops itself when its socket file is gone (home deleted, or replaced)", async () => {
    const sock = join(env.home, "g.sock");
    const d = new Daemon({
      idleMinutes: 0,
      maintenanceMs: 20,
      socketPath: sock,
      lockPath: join(env.home, "g.lock"),
      log: () => {},
    });
    let stopped = 0;
    d.onStop = () => stopped++;
    expect(await d.start()).toBe(true);
    unlinkSync(sock);
    for (let i = 0; i < 50 && !stopped; i++) await Bun.sleep(20);
    expect(stopped).toBe(1);
  });
  test("stop: a request in flight still gets its reply, and a client that stays connected does not hold stop open", async () => {
    const sock = join(env.home, "f.sock");
    const d = new Daemon({
      idleMinutes: 0,
      socketPath: sock,
      lockPath: join(env.home, "f.lock"),
      log: () => {},
    });
    expect(await d.start()).toBe(true);
    const handle = d.handleLine.bind(d);
    d.handleLine = async (line) => {
      await Bun.sleep(300); // a slow request
      return handle(line);
    };
    const idle = await DaemonClient.tryConnect(sock); // like an MCP proxy: connected, never closes
    const busy = await DaemonClient.tryConnect(sock);
    expect(idle && busy).toBeTruthy();
    const reply = busy!.request({ type: "status" });
    await Bun.sleep(50);
    let stopped = 0;
    d.onStop = () => stopped++;
    const t0 = Date.now();
    await d.stop();
    expect((await reply).ok).toBe(true);
    expect(stopped).toBe(1);
    expect(Date.now() - t0).toBeLessThan(3000);
    idle!.close();
    busy!.close();
  });
  test("a shutdown step that never finishes: the process still ends at the deadline", async () => {
    const d = new Daemon({
      idleMinutes: 0,
      shutdownMs: 150,
      socketPath: join(env.home, "h.sock"),
      lockPath: join(env.home, "h.lock"),
      log: () => {},
    });
    expect(await d.start()).toBe(true);
    const drain = d.ctx.queue.drain.bind(d.ctx.queue);
    d.ctx.queue.drain = () => new Promise<void>(() => {}); // hangs forever
    let stopped = 0;
    d.onStop = () => stopped++;
    void d.stop();
    await Bun.sleep(400);
    expect(stopped).toBe(1);
    d.ctx.queue.drain = drain;
    d.ctx.close();
  });
  test("socket is private to the user", () => {
    const mode = Bun.spawnSync(["stat", "-f", "%Lp", paths.socket()]).stdout.toString().trim();
    if (process.platform === "darwin") expect(mode).toBe("600");
  });
});
