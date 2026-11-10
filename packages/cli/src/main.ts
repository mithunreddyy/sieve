#!/usr/bin/env bun
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as claude from "@sieve/adapter-claude-code";
import { GlobalStore, paths } from "@sieve/core";
import { Daemon, DaemonClient } from "@sieve/daemon";
import { PROTOCOL_VERSION, SIEVE_VERSION, type StatusReport, type ToolResult } from "@sieve/protocol";
import { runHook } from "./hook.ts";

const compiled = Bun.main.startsWith("/$bunfs") || Bun.main.startsWith("B:\\~BUN");
const repoRoot = compiled ? null : resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}
function bool(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function ago(ms: number | null): string {
  if (ms === null) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Where the shim lives: next to the compiled binary, or dist/ in a source checkout. */
function shimPath(override?: string): string {
  if (override) return resolve(override);
  const exe = process.platform === "win32" ? "sieve-hook.exe" : "sieve-hook";
  return compiled ? join(dirname(process.execPath), exe) : join(repoRoot!, "dist", exe);
}
function sieveInvocation(): { path: string; args: string[] } {
  return compiled
    ? { path: process.execPath, args: [] }
    : { path: process.execPath, args: [join(repoRoot!, "packages", "cli", "src", "main.ts")] };
}

async function tool(name: string, args: Record<string, unknown>): Promise<number> {
  const c = await DaemonClient.connect({ autostart: true, waitMs: 3000 });
  if (!c) return die("Could not reach or start the Sieve daemon. See ~/.sieve/logs/sieved.log");
  const r = await c.request(
    { type: "tool", tool: name, args, cwd: process.cwd(), client: `sieve-cli/${SIEVE_VERSION}` },
    620_000,
  );
  c.close();
  if (!r.ok) return die(`${r.error.code}: ${r.error.message}`);
  const res = r.result as ToolResult;
  console.log(res.content);
  return res.isError ? 1 : 0;
}

function die(msg: string): number {
  console.error(`sieve: ${msg}`);
  return 1;
}

function shimVersion(path: string): string | null {
  try {
    return execFileSync(path, ["--version"], { encoding: "utf8", timeout: 2000 }).trim();
  } catch {
    return null;
  }
}

async function status(json: boolean): Promise<number> {
  const c = await DaemonClient.connect({ autostart: false });
  const problems = claude.verifySetup({ shimPath: shimPath(), sievePath: sieveInvocation().path });
  if (!c) {
    if (json) console.log(JSON.stringify({ daemon: null, claudeCode: problems }));
    else
      console.log(
        "daemon: not running (it starts on the next hook or MCP call; `sieve daemon run` starts it now)",
      );
    return 1;
  }
  const r = await c.request({ type: "status" });
  c.close();
  if (!r.ok) return die(r.error.message);
  const s = r.result as StatusReport;
  if (json) {
    console.log(JSON.stringify({ ...s, claudeCode: problems }, null, 2));
    return 0;
  }
  const mb = (s.daemon.rssBytes / 1024 / 1024).toFixed(0);
  console.log(
    `daemon   v${s.daemon.version} (protocol ${s.daemon.protocol}) · pid ${s.daemon.pid} · up ${Math.round(s.daemon.uptimeMs / 60000)} min · ${mb} MB · idle shutdown ${s.idleShutdownMinutes || "off"}${s.idleShutdownMinutes ? " min" : ""}`,
  );
  if (s.daemon.version !== SIEVE_VERSION)
    console.log(`         ! CLI is v${SIEVE_VERSION}; restart the daemon: sieve daemon stop`);
  console.log(`queue    hook ${s.queue.hook} · tool ${s.queue.tool} · background ${s.queue.background}`);
  console.log(
    `misses   ${s.misses.last24h} in 24h (${s.misses.total} total)${s.misses.lastAt ? ` · last ${ago(s.misses.lastAt)}: ${s.misses.lastReason}` : ""}`,
  );
  console.log(`projects ${s.projects}`);
  if (s.agents.length === 0) console.log("agents   none have called in yet");
  for (const a of s.agents) {
    console.log(
      `agent    ${a.agent} · last hook ${ago(a.lastHookAt)} · p50 ${a.latencyMs.p50} ms · p99 ${a.latencyMs.p99} ms (in daemon, ${a.latencyMs.count} calls)`,
    );
    for (const e of a.events)
      console.log(`           ${e.event.padEnd(18)} ${String(e.count).padStart(7)} · ${ago(e.lastAt)}`);
  }
  const installed = existsSync(join(homedir(), ".claude"));
  const cc = s.agents.find((a) => a.agent === "claude-code");
  if (installed && problems.length && problems.length < 10) {
    console.log("! claude-code: config no longer points at Sieve:");
    for (const p of problems) console.log(`    - ${p}`);
    console.log("  fix: sieve setup --agents claude-code");
  } else if (installed && !problems.length && cc?.lastHookAt && Date.now() - cc.lastHookAt > 7 * 86_400_000) {
    console.log(
      "! claude-code: hooks are registered but have not fired in 7 days. Is Claude Code loading this settings file?",
    );
  }
  return 0;
}

async function doctor(): Promise<number> {
  let failed = 0;
  const check = (ok: boolean, label: string, fix?: string, warnOnly = false) => {
    console.log(
      `${ok ? "ok  " : warnOnly ? "warn" : "FAIL"}  ${label}${!ok && fix ? `\n      fix: ${fix}` : ""}`,
    );
    if (!ok && !warnOnly) failed++;
  };
  const shim = shimPath();
  const sv = shimVersion(shim);
  check(sv !== null, `shim ${shim}${sv ? ` (${sv})` : " not found"}`, "bun run build");
  if (sv)
    check(
      sv.includes(SIEVE_VERSION) && sv.includes(`protocol ${PROTOCOL_VERSION}`),
      `shim and CLI versions match (CLI ${SIEVE_VERSION}, protocol ${PROTOCOL_VERSION})`,
      "reinstall Sieve so both binaries come from one release",
    );
  const c = await DaemonClient.connect({ autostart: true, waitMs: 3000 });
  check(c !== null, "daemon reachable", `check ${paths.daemonLog()}`);
  if (c) {
    const r = await c.request({ type: "status" });
    c.close();
    if (r.ok) {
      const s = r.result as StatusReport;
      check(
        s.daemon.version === SIEVE_VERSION,
        `daemon version ${s.daemon.version}`,
        "sieve daemon stop (the next call starts the new one)",
      );
      const cc = s.agents.find((a) => a.agent === "claude-code");
      check(
        !!cc && Date.now() - (cc.lastHookAt ?? 0) < 86_400_000,
        `claude-code hooks fired in the last 24 h (last: ${ago(cc?.lastHookAt ?? null)})`,
        "open Claude Code in a project; if it stays silent, run sieve setup --agents claude-code",
        true,
      );
      if (cc)
        check(
          cc.latencyMs.p99 < 30,
          `hook handling p99 ${cc.latencyMs.p99} ms in daemon (budget 30 ms end to end)`,
          "sieve bench latency",
          true,
        );
      check(
        s.misses.last24h === 0,
        `hook misses in 24 h: ${s.misses.last24h}${s.misses.lastReason ? ` (last: ${s.misses.lastReason})` : ""}`,
        "misses right after a cold start are expected; others: see the daemon log",
        true,
      );
    }
  }
  const problems = claude.verifySetup({ shimPath: shim, sievePath: sieveInvocation().path });
  check(
    problems.length === 0,
    `claude-code config${problems.length ? `: ${problems.join("; ")}` : " points at Sieve"}`,
    "sieve setup --agents claude-code",
    true,
  );
  try {
    const g = new GlobalStore();
    const q = g.db.query("PRAGMA quick_check").get() as { quick_check: string };
    g.close();
    check(
      q.quick_check === "ok",
      `database integrity (${paths.globalDb()})`,
      "move the file aside; Sieve recreates it",
    );
  } catch (e) {
    check(false, `database: ${(e as Error).message}`);
  }
  const mcp = await mcpHandshake();
  check(
    mcp.ok,
    mcp.ok
      ? `MCP handshake: ${mcp.tools} tools, schemas ≈ ${mcp.tokens} tokens`
      : `MCP handshake failed: ${mcp.error}`,
  );
  check(
    false,
    "isolation: none — sieve_run code runs as you with full file and network access (sandbox lands in slice 6)",
    undefined,
    true,
  );
  check(false, "file watcher: not built yet (slice 3)", undefined, true);
  return failed ? 1 : 0;
}

async function mcpHandshake(): Promise<
  { ok: true; tools: number; tokens: number } | { ok: false; error: string }
> {
  const inv = sieveInvocation();
  const child = spawn(inv.path, [...inv.args, "mcp"], { stdio: ["pipe", "pipe", "ignore"] });
  const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
  let buf = "";
  const replies = new Map<number, unknown>();
  child.stdout.on("data", (d) => {
    buf += d;
    for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const m = JSON.parse(line);
        if (typeof m.id === "number") replies.set(m.id, m);
      } catch {}
    }
  });
  const wait = async (id: number) => {
    for (let i = 0; i < 200 && !replies.has(id); i++) await Bun.sleep(25);
    return replies.get(id) as { result?: { tools?: unknown[] } } | undefined;
  };
  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "sieve-doctor", version: SIEVE_VERSION },
      },
    });
    if (!(await wait(1))) return { ok: false, error: "no reply to initialize" };
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = await wait(2);
    const tools = list?.result?.tools ?? [];
    const { countTokens } = await import("@sieve/core");
    return { ok: true, tools: tools.length, tokens: countTokens(JSON.stringify(tools)) };
  } finally {
    child.kill();
  }
}

async function setup(args: string[]): Promise<number> {
  const agents = flag(args, "--agents") ?? "detect";
  const remove = bool(args, "--remove");
  const dryRun = bool(args, "--dry-run");
  const restore = flag(args, "--restore");
  const shim = shimPath(flag(args, "--shim"));
  if (restore) {
    const files = claude.restoreBackup(resolve(restore));
    console.log(files.length ? `Restored:\n  ${files.join("\n  ")}` : "Nothing to restore.");
    return 0;
  }
  const wanted =
    agents === "all" || agents === "detect" ? ["claude-code"] : agents.split(",").map((s) => s.trim());
  const unknown = wanted.filter((a) => a !== "claude-code");
  if (unknown.length) console.log(`Not supported yet (coming in slice 5/12): ${unknown.join(", ")}`);
  if (!wanted.includes("claude-code")) return unknown.length ? 1 : 0;
  if (agents === "detect" && !existsSync(join(homedir(), ".claude")) && !Bun.which("claude")) {
    console.log("No supported agents detected (looked for Claude Code).");
    return 0;
  }
  if (!remove && !existsSync(shim))
    return die(`shim not found at ${shim}. Build it (bun run build) or pass --shim <path>.`);
  const inv = sieveInvocation();
  const opts = { shimPath: shim, sievePath: inv.path, sieveArgs: inv.args };
  const plan = claude.planSetup(opts, remove);
  if (plan.length === 0) {
    console.log(`claude-code: already ${remove ? "removed" : "set up"}; nothing to change.`);
    return 0;
  }
  console.log(`Plan for claude-code${dryRun ? " (dry run, nothing written)" : ""}:`);
  for (const c of plan) {
    console.log(`  ${c.file}${c.before === null ? " (new file)" : ""}`);
    for (const s of c.summary) console.log(`    - ${s}`);
  }
  if (dryRun) return 0;
  const r = claude.applySetup(opts, remove);
  if (r.rolledBack) return die(`setup check failed, every file was restored: ${r.error}`);
  console.log(
    `Done. Backups: ${r.backupDir}\nUndo: sieve setup --restore ${r.backupDir}   (or: sieve setup --remove)`,
  );
  console.log("Sieve did not touch CLAUDE.md or any other instruction file.");
  return 0;
}

const HELP = `sieve ${SIEVE_VERSION} — local context engine for coding agents

  sieve setup [--agents claude-code|detect] [--dry-run] [--remove] [--restore <backup-dir>] [--shim <path>]
  sieve status [--json]          daemon, connected agents, hook health, misses
  sieve doctor                   checks with a fix for each failure
  sieve search <query> [--scope session|worktree|project] [--sort relevance|timeline]
  sieve get <id> [--lines a-b]   expand an archived item exactly
  sieve stats
  sieve daemon run|stop          run the daemon in the foreground / stop it
  sieve mcp                      MCP stdio server (agents start this)
  sieve hook <agent> [event]     TypeScript hook fallback (the Go shim is faster)
  sieve version`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "daemon": {
      if (args[0] === "stop") {
        const c = await DaemonClient.connect({ autostart: false });
        if (!c) {
          console.log("daemon is not running");
          return 0;
        }
        await c.request({ type: "shutdown" });
        c.close();
        console.log("daemon stopping");
        return 0;
      }
      if (args[0] !== "run") return die("usage: sieve daemon run|stop");
      const d = new Daemon();
      if (!(await d.start())) {
        console.error("sieved: another daemon is already running");
        return 0;
      }
      d.onStop = () => process.exit(0);
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void d.stop());
      return new Promise<number>(() => {});
    }
    case "status":
      return status(bool(args, "--json"));
    case "doctor":
      return doctor();
    case "setup":
      return setup(args);
    case "get": {
      const lines = flag(args, "--lines");
      if (!args[0]) return die("usage: sieve get <id> [--lines a-b]");
      return tool("sieve_get", { id: args[0], ...(lines ? { lines } : {}) });
    }
    case "search": {
      const scope = flag(args, "--scope");
      const sort = flag(args, "--sort");
      const cursor = flag(args, "--cursor");
      if (!args.length) return die("usage: sieve search <query>");
      return tool("sieve_search", {
        query: args.join(" "),
        ...(scope ? { scope } : {}),
        ...(sort ? { sort } : {}),
        ...(cursor ? { cursor } : {}),
      });
    }
    case "stats":
      return tool("sieve_stats", {});
    case "mcp": {
      const { runMcpServer } = await import("@sieve/mcp");
      await runMcpServer();
      return new Promise<number>(() => {});
    }
    case "hook":
      return runHook(args[0] ?? "", args[1] ?? "");
    case "version":
    case "--version":
      console.log(`sieve ${SIEVE_VERSION} protocol ${PROTOCOL_VERSION}`);
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      return die(`unknown command "${cmd}". Run sieve help.`);
  }
}

process.exitCode = await main(process.argv.slice(2));
if (!["daemon", "mcp"].includes(process.argv[2] ?? "")) process.exit(process.exitCode);
