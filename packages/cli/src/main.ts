#!/usr/bin/env bun
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as claude from "@sieve/adapter-claude-code";
import * as codex from "@sieve/adapter-codex";
import * as copilotCli from "@sieve/adapter-copilot-cli";
import * as cursor from "@sieve/adapter-cursor";
import * as gemini from "@sieve/adapter-gemini-cli";
import { type AgentSetup, applySetup, fixFor, restoreBackup } from "@sieve/adapter-kit";
import { mcpOnlySetups } from "@sieve/adapter-mcp-only";
import * as opencode from "@sieve/adapter-opencode";
import { GlobalStore, loadConfig, paths } from "@sieve/core";
import { Daemon, DaemonClient } from "@sieve/daemon";
import { PROTOCOL_VERSION, SIEVE_VERSION, type StatusReport, type ToolResult } from "@sieve/protocol";
import { detect as detectSandbox } from "@sieve/sandbox";
import { dashCommand, tuiCommand } from "./dash.ts";
import { guardCommand, guardStatusLine } from "./guard.ts";
import { runHook } from "./hook.ts";
import { memoryCommand, memoryStatusLine } from "./memory.ts";
import { notifyProblems } from "./notify.ts";
import { proxyCommand } from "./proxy.ts";
import { serviceCommand } from "./service.ts";
import { sessionCommand } from "./session.ts";
import { skillsCommand } from "./skills.ts";
import { syncCommand } from "./sync.ts";
import { upgradeCommand } from "./upgrade.ts";

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

/** Every agent Sieve can set up. "preview": not yet exercised by a real session of that agent. */
const SETUPS: AgentSetup[] = [
  claude.setupSpec as AgentSetup,
  gemini.setupSpec as AgentSetup,
  opencode.setupSpec as AgentSetup,
  cursor.setupSpec as AgentSetup,
  codex.setupSpec as AgentSetup,
  copilotCli.setupSpec as AgentSetup,
  ...(mcpOnlySetups as AgentSetup[]),
];

/** Installed agents and what is wrong with their config (empty: points at Sieve). */
function setupChecks(): Array<{ agent: string; support: string; problems: string[] }> {
  const opts = { shimPath: shimPath(), sievePath: sieveInvocation().path };
  return SETUPS.filter((a) => a.detect()).map((a) => ({
    agent: a.agent,
    support: a.support,
    problems: a.verify(opts),
  }));
}

async function status(json: boolean): Promise<number> {
  const c = await DaemonClient.connect({ autostart: false });
  const checks = setupChecks();
  if (!c) {
    if (json) console.log(JSON.stringify({ daemon: null, setup: checks }));
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
    console.log(JSON.stringify({ ...s, setup: checks }, null, 2));
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
  console.log(`isolation ${isolationLine().text.replace(/^isolation: /, "")}`);
  try {
    const gs = guardStatusLine();
    console.log(`guard    ${gs.text}`);
    for (const p of gs.problems) console.log(`! guard: ${p}`);
  } catch {}
  try {
    console.log(`memory   ${memoryStatusLine()}`);
  } catch {}
  const k = s.counters;
  console.log(
    `saved    ${k.folds} folds, ${k.rerunsShortened} reruns shortened, ${k.readsDeclined} reads answered without resending (since daemon start)`,
  );
  console.log(`outlines ${s.outlines ? "ready" : "loading"}`);
  for (const w of s.watchers) {
    console.log(
      `watching ${w.worktree} · ${w.files} files, ${w.symbols} symbols${w.scanned ? "" : " (first scan running)"}${w.git ? ` · last git: ${w.git.message}` : ""}${w.error ? ` · ERROR ${w.error}` : ""}`,
    );
  }
  if (s.agents.length === 0) console.log("agents   none have called in yet");
  for (const a of s.agents) {
    console.log(
      `agent    ${a.agent} · last hook ${ago(a.lastHookAt)} · p50 ${a.latencyMs.p50} ms · p99 ${a.latencyMs.p99} ms (in daemon, ${a.latencyMs.count} calls)`,
    );
    for (const e of a.events)
      console.log(`           ${e.event.padEnd(18)} ${String(e.count).padStart(7)} · ${ago(e.lastAt)}`);
  }
  for (const ch of checks) {
    const seen = s.agents.find((a) => a.agent === ch.agent);
    const tag = ch.support === "preview" ? " (preview adapter)" : "";
    // Nothing of Sieve's in the config at all: the user never set this agent up. Say nothing.
    const neverSetUp = !seen && ch.problems.every((p) => /not registered/.test(p));
    if (neverSetUp) continue;
    if (ch.problems.length) {
      console.log(`! ${ch.agent}${tag}: config no longer points at Sieve:`);
      for (const p of ch.problems) console.log(`    - ${p}`);
      console.log(`  fix: ${fixFor(ch.agent, ch.problems)}`);
    } else if (!seen?.lastHookAt) {
      console.log(`! ${ch.agent}${tag}: set up, but no hook has fired since the daemon started`);
    } else if (Date.now() - seen.lastHookAt > 7 * 86_400_000) {
      console.log(`! ${ch.agent}${tag}: hooks are registered but have not fired in 7 days`);
    }
  }
  return 0;
}

/** What `sieve_run` is isolated by on this machine, stated as it is (also in every run receipt). */
function isolationLine(): { ok: boolean; text: string; fix?: string } {
  const mode = loadConfig().sandbox.mode;
  if (mode === "off")
    return {
      ok: false,
      text: "isolation: none — turned off in config (sandbox.mode = off); sieve_run code runs as you, with full file and network access",
      fix: 'remove sandbox.mode = "off" from ~/.sieve/config.toml',
    };
  const av = detectSandbox();
  if (av.kind === "none")
    return {
      ok: false,
      text: `isolation: none — ${av.detail}; sieve_run code runs as you, with full file and network access${mode === "require" ? " (sandbox.mode = require: runs are refused)" : ""}`,
      fix: process.platform === "linux" ? "install bubblewrap (bwrap) and allow user namespaces" : undefined,
    };
  return {
    ok: true,
    text: `isolation: ${av.kind} — sieve_run writes only to the project and a scratch folder, network off, credential folders unreadable, environment allowlisted; memory and process counts are not limited`,
  };
}

async function doctor(): Promise<number> {
  let failed = 0;
  let watchers: { outlines: boolean; list: StatusReport["watchers"] } | null = null;
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
      for (const ch of setupChecks()) {
        const a = s.agents.find((x) => x.agent === ch.agent);
        if (ch.problems.length && !a) continue; // installed, never set up: reported below
        check(
          !!a && Date.now() - (a.lastHookAt ?? 0) < 86_400_000,
          `${ch.agent} hooks fired in the last 24 h (last: ${ago(a?.lastHookAt ?? null)})`,
          `open ${ch.agent} in a project; if it stays silent, run sieve setup --agents ${ch.agent}`,
          true,
        );
        if (a)
          check(
            a.latencyMs.p99 < 30,
            `${ch.agent} hook handling p99 ${a.latencyMs.p99} ms in daemon (budget 30 ms end to end)`,
            "sieve bench latency",
            true,
          );
      }
      watchers = { outlines: s.outlines, list: s.watchers };
      check(
        s.misses.last24h === 0,
        `hook misses in 24 h: ${s.misses.last24h}${s.misses.lastReason ? ` (last: ${s.misses.lastReason})` : ""}`,
        "misses right after a cold start are expected; others: see the daemon log",
        true,
      );
    }
  }
  for (const ch of setupChecks()) {
    const tag = ch.support === "preview" ? " (preview adapter, not yet verified by a live session)" : "";
    check(
      ch.problems.length === 0,
      `${ch.agent} config${ch.problems.length ? `: ${ch.problems.join("; ")}` : " points at Sieve"}${tag}`,
      fixFor(ch.agent, ch.problems),
      true,
    );
  }
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
  const iso = isolationLine();
  check(iso.ok, iso.text, iso.fix, true);
  try {
    const gs = guardStatusLine();
    check(
      gs.problems.length === 0,
      `guard: ${gs.text}${gs.problems.length ? `; ${gs.problems.join("; ")}` : ""}`,
      "sieve guard test; sieve guard log --verify",
      true,
    );
  } catch (e) {
    check(false, `guard: ${(e as Error).message}`, undefined, true);
  }
  if (watchers) {
    check(
      watchers.outlines,
      `outline parsers ${watchers.outlines ? "loaded" : "not loaded (see the daemon log)"}`,
    );
    const bad = watchers.list.filter((w) => w.error);
    check(
      bad.length === 0,
      `file watchers: ${watchers.list.length} running${bad.length ? `; errors: ${bad.map((w) => `${w.worktree}: ${w.error}`).join("; ")}` : ""}`,
      "set watch.enabled = false in ~/.sieve/config.toml to turn watching off",
      true,
    );
  }
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
    const files = restoreBackup(resolve(restore));
    console.log(files.length ? `Restored:\n  ${files.join("\n  ")}` : "Nothing to restore.");
    return 0;
  }
  const names = SETUPS.map((a) => a.agent);
  let chosen: AgentSetup[];
  if (agents === "all") chosen = SETUPS;
  else if (agents === "detect") {
    chosen = SETUPS.filter((a) => a.detect());
    if (!chosen.length) {
      console.log(`No supported agents detected (looked for ${names.join(", ")}).`);
      return 0;
    }
  } else {
    const wanted = agents
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const unknown = wanted.filter((w) => !names.includes(w));
    if (unknown.length)
      console.log(`Not supported yet: ${unknown.join(", ")} (supported: ${names.join(", ")})`);
    chosen = SETUPS.filter((a) => wanted.includes(a.agent));
    if (!chosen.length) return 1;
  }
  if (!remove && !existsSync(shim))
    return die(`shim not found at ${shim}. Build it (bun run build) or pass --shim <path>.`);
  const inv = sieveInvocation();
  const opts = { shimPath: shim, sievePath: inv.path, sieveArgs: inv.args };
  let failed = 0;
  for (const a of chosen) {
    const tag = a.support === "preview" ? " (preview: not yet verified by a live session)" : "";
    let plan: ReturnType<typeof a.plan>;
    try {
      plan = a.plan(opts, remove);
    } catch (e) {
      // An adapter refuses rather than overwrite a file it cannot round-trip; nothing was written.
      failed++;
      console.error(`sieve: ${a.agent}${tag}: ${(e as Error).message}`);
      continue;
    }
    if (plan.length === 0) {
      console.log(`${a.agent}: already ${remove ? "removed" : "set up"}; nothing to change.`);
      continue;
    }
    console.log(`Plan for ${a.agent}${tag}${dryRun ? " (dry run, nothing written)" : ""}:`);
    for (const c of plan) {
      console.log(`  ${c.file}${c.before === null ? " (new file)" : ""}`);
      for (const x of c.summary) console.log(`    - ${x}`);
    }
    if (dryRun) continue;
    const r = applySetup(a, opts, remove);
    if (r.rolledBack) {
      failed++;
      console.error(`sieve: ${a.agent}: setup check failed, its files were restored: ${r.error}`);
      continue;
    }
    if (a.after) console.log(`${a.agent}: ${a.after}`);
    console.log(
      `${a.agent}: done. Backups: ${r.backupDir}\n  Undo: sieve setup --restore ${r.backupDir}   (or: sieve setup --agents ${a.agent} --remove)`,
    );
  }
  if (!dryRun)
    console.log("Sieve did not touch CLAUDE.md, GEMINI.md, AGENTS.md or any other instruction file.");
  return failed ? 1 : 0;
}

const HELP = `sieve ${SIEVE_VERSION} — local context engine for coding agents

  sieve setup [--agents claude-code,gemini-cli,opencode,cursor,codex,copilot-cli|all|detect] [--dry-run] [--remove] [--restore <backup-dir>] [--shim <path>]
  sieve status [--json]          daemon, connected agents, hook health, misses
  sieve doctor                   checks with a fix for each failure
  sieve guard check <command>|--read <path>|--write <path>|--url <url>   what the rules say, and why
  sieve guard test [--preset <name>]    run every rule's saved tests
  sieve guard log [-n 20] [--verify] [--json]   decisions; --verify checks the hash chain
  sieve guard mode <enforce|monitor> [--reason "why"]   block or just log (loosening needs a reason)
  sieve guard init [observe|balanced|locked]   write ~/.sieve/guard.toml
  sieve memory list [subject] [--history] | review | sync [--dry-run] | edit <id> (--object v | --retract) | prune [--days 90] [--yes]
  sieve skills add <git-url|folder> | list | enable|disable|remove <name> | verify [name] | match "<prompt>"
  sieve dash [--port N]          local web dashboard (127.0.0.1, token in the printed URL)
  sieve tui [--once]             live terminal view; --once prints one frame
  sieve proxy [--port N]         local gateway for Anthropic/OpenAI/Gemini-shaped APIs (trim, receipts, cache marks, budgets)
  sieve session list | export [<id>] [-o file] [--encrypt] | import <file> [--as id]   move a session between machines
  sieve sync init <folder> | push | pull | status   encrypted sync through a folder you sync yourself
  sieve service install|uninstall|status [--dry-run]   start the daemon at login
  sieve upgrade --from <file|https-url> --sha256 <hex> | --sha256-file SHA256SUMS   replace this binary with a verified one
  sieve notify-check [--dry-run]  OS notification for an agent whose config no longer points at Sieve
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
    case "guard":
      return guardCommand(args);
    case "memory":
      return memoryCommand(args);
    case "dash":
      return dashCommand(args);
    case "proxy":
      return proxyCommand(args);
    case "notify-check": {
      const problems = setupChecks().filter((c) => c.problems.length);
      if (bool(args, "--dry-run")) {
        for (const c of problems) for (const p of c.problems) console.log(`${c.agent}: ${p}`);
        if (!problems.length) console.log("Every detected agent points at Sieve.");
        return 0;
      }
      for (const l of notifyProblems(problems)) console.log(`notified: ${l}`);
      return 0;
    }
    case "session":
      return sessionCommand(args);
    case "sync":
      return syncCommand(args);
    case "service":
      return serviceCommand(args);
    case "upgrade":
      return upgradeCommand(args);
    case "tui":
      return tuiCommand(args);
    case "skills":
      return skillsCommand(args);
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
