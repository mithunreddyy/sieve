/**
 * End-to-end tests against the compiled binaries in dist/ (run `bun run build` first).
 * These cover start on demand, fault injection (killed / hung daemon), idle shutdown and
 * the MCP handshake: the paths where a broken Sieve could break an agent session.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bashPost, bigOutput, freshHome, runShim, SHIM, SIEVE } from "./helpers.ts";

const built = existsSync(SHIM) && existsSync(SIEVE);
const d = built ? describe : describe.skip;

let env: ReturnType<typeof freshHome>;
let project: string;
const shimEnv = () => ({ SIEVE_HOME: env.home, SIEVE_BIN: SIEVE });

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await Bun.sleep(25);
  }
  return false;
}
const daemonPid = () => {
  const lock = join(env.home, "run", "sieved.lock");
  return existsSync(lock) ? Number(readFileSync(lock, "utf8")) : 0;
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const socketUp = () => existsSync(join(env.home, "run", "sieved.sock"));

beforeEach(() => {
  env = freshHome();
  project = join(env.home, "p");
  mkdirSync(project);
});
afterEach(async () => {
  const pid = daemonPid();
  if (pid && alive(pid)) process.kill(pid, "SIGKILL");
  env.cleanup();
});

d("compiled binaries", () => {
  test("first hook starts the daemon and passes through; later hooks are served", async () => {
    const out = bigOutput();
    const first = await runShim(bashPost(out, project), shimEnv());
    expect(first.code).toBe(0);
    expect(first.stdout).toBe(""); // cold start: raw pass-through, never blocks
    expect(first.ms).toBeLessThan(400);
    expect(readFileSync(join(env.home, "run", "misses.log"), "utf8")).toContain("daemon-down");
    expect(await waitFor(socketUp)).toBe(true);
    const second = await runShim(bashPost(out, project), shimEnv());
    expect(second.stdout).toContain("[sieve s_");
  });

  test("a daemon killed with SIGKILL never breaks the agent, and comes back", async () => {
    await runShim(bashPost("x", project), shimEnv());
    expect(await waitFor(socketUp)).toBe(true);
    const pid = daemonPid();
    process.kill(pid, "SIGKILL");
    await waitFor(() => !alive(pid));
    // Stale socket + stale lock left behind. The agent's call must still pass straight through.
    const r = await runShim(bashPost(bigOutput(), project), shimEnv());
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(await waitFor(async () => daemonPid() !== pid && alive(daemonPid()) && socketUp())).toBe(true);
    expect(
      await waitFor(async () =>
        (await runShim(bashPost(bigOutput(), project), shimEnv())).stdout.includes("[sieve s_"),
      ),
    ).toBe(true);
  });

  test("a hung daemon costs at most the hook timeout", async () => {
    await runShim(bashPost("x", project), shimEnv());
    expect(await waitFor(socketUp)).toBe(true);
    const pid = daemonPid();
    process.kill(pid, "SIGSTOP");
    try {
      const r = await runShim(bashPost(bigOutput(), project), { ...shimEnv(), SIEVE_HOOK_TIMEOUT_MS: "200" });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.ms).toBeLessThan(600);
    } finally {
      process.kill(pid, "SIGCONT");
    }
  });

  test("idle shutdown removes the socket and lock", async () => {
    const p = Bun.spawn([SIEVE, "daemon", "run"], {
      env: { ...process.env, SIEVE_HOME: env.home, SIEVE_IDLE_MINUTES: "0.01" },
      stderr: "ignore",
    });
    expect(await waitFor(socketUp)).toBe(true);
    expect(await p.exited).toBe(0);
    expect(socketUp()).toBe(false);
    expect(existsSync(join(env.home, "run", "sieved.lock"))).toBe(false);
  });

  test("the outline worker runs inside the compiled binary and indexes symbols", async () => {
    const repo = join(env.home, "wrepo");
    mkdirSync(repo);
    writeFileSync(join(repo, "a.ts"), "export class Alpha {\n  beta() {}\n}\n");
    Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    await runShim(
      { session_id: "w", cwd: repo, hook_event_name: "SessionStart", source: "startup" },
      shimEnv(),
      "SessionStart",
    );
    expect(await waitFor(socketUp)).toBe(true);
    await runShim(
      { session_id: "w", cwd: repo, hook_event_name: "SessionStart", source: "startup" },
      shimEnv(),
      "SessionStart",
    );
    const ok = await waitFor(() => {
      const r = Bun.spawnSync([SIEVE, "status", "--json"], { env: { ...process.env, SIEVE_HOME: env.home } });
      try {
        const s = JSON.parse(r.stdout.toString());
        return s.outlines === true && s.watchers.some((w: { symbols: number }) => w.symbols >= 2);
      } catch {
        return false;
      }
    }, 10_000);
    expect(ok).toBe(true);
  });

  test("status reports the connected agent", async () => {
    await runShim(bashPost("x", project), shimEnv());
    expect(await waitFor(socketUp)).toBe(true);
    await runShim(bashPost(bigOutput(), project), shimEnv());
    const r = Bun.spawnSync([SIEVE, "status", "--json"], { env: { ...process.env, SIEVE_HOME: env.home } });
    const s = JSON.parse(r.stdout.toString());
    expect(s.agents[0].agent).toBe("claude-code");
    expect(s.misses.total).toBeGreaterThanOrEqual(1);
  });

  test("MCP handshake, strict schemas, and a tool call", async () => {
    const p = Bun.spawn([SIEVE, "mcp"], {
      cwd: project,
      env: { ...process.env, SIEVE_HOME: env.home },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    const reader = p.stdout.getReader();
    let buf = "";
    const next = async (id: number) => {
      for (;;) {
        for (const line of buf.split("\n")) {
          try {
            const m = JSON.parse(line);
            if (m.id === id) return m;
          } catch {}
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("mcp closed");
        buf += new TextDecoder().decode(value);
      }
    };
    const send = (m: unknown) => {
      p.stdin.write(`${JSON.stringify(m)}\n`);
      p.stdin.flush();
    };
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      });
      expect((await next(1)).result.serverInfo.name).toBe("sieve");
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const tools = (await next(2)).result.tools as Array<{
        name: string;
        description: string;
        inputSchema: { additionalProperties?: boolean };
      }>;
      expect(tools.map((t) => t.name).sort()).toEqual([
        "sieve_batch",
        "sieve_get",
        "sieve_index",
        "sieve_read",
        "sieve_recall",
        "sieve_remember",
        "sieve_resume",
        "sieve_run",
        "sieve_schema",
        "sieve_search",
        "sieve_stats",
      ]);
      for (const t of tools) {
        expect(t.description.length).toBeLessThan(400);
        expect(t.inputSchema.additionalProperties).toBe(false);
      }
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "sieve_run", arguments: { language: "shell", code: "echo from-mcp" } },
      });
      const r = await next(3);
      expect(r.result.content[0].text).toContain("from-mcp");
      send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "sieve_get", arguments: { id: "s_x", bogus: true } },
      });
      const bad = await next(4);
      expect(bad.result.isError).toBe(true);
      expect(bad.result.content[0].text).toContain("unknown field(s): bogus");
    } finally {
      p.kill();
    }
  });
});
