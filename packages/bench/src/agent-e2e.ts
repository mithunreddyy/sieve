import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import * as claude from "@sieve/adapter-claude-code";
import * as codex from "@sieve/adapter-codex";
import * as copilot from "@sieve/adapter-copilot-cli";
import * as cursor from "@sieve/adapter-cursor";
import * as gemini from "@sieve/adapter-gemini-cli";
import { type AgentSetup, applySetup, type BaseSetupOptions } from "@sieve/adapter-kit";
import * as opencode from "@sieve/adapter-opencode";
import type { StatusReport } from "@sieve/protocol";

/**
 * Real-agent check, the evidence behind "verified" in the support matrix: run the actual agent
 * once, non-interactively, in a throwaway git repo whose *project-level* config points at this
 * build of Sieve (nothing in your home folder is touched), then ask the daemon what it saw.
 *
 * It spends one short model call on the agent's own account, so it only runs with `--run`
 * (in CI: a job with the agent's credentials). Everything else here is checked offline.
 */

const REPO = resolve(import.meta.dir, "../../..");
export const PROMPT =
  "Use your shell tool to run exactly `seq 1 4000` and then reply with only the number of lines it printed. Do not run anything else.";

export interface AgentE2E {
  agent: string;
  /** Adapter module: setupSpec plus the event table. */
  mod: {
    setupSpec: AgentSetup<never>;
    HOOK_EVENTS?: Record<string, string>;
    EVENTS?: Record<string, string>;
  };
  bin: string;
  /** Command line for a non-interactive run, and the project-level config paths to set up. */
  argv: (prompt: string) => string[];
  options: (project: string) => Record<string, unknown>;
  /** Environment the agent needs to find the config above (e.g. COPILOT_HOME). */
  env?: (project: string) => Record<string, string>;
  /** Anything the run needs besides the config (documented in the agent's own help). */
  note?: string;
}

export const AGENTS: AgentE2E[] = [
  {
    agent: "claude-code",
    mod: claude as never,
    bin: "claude",
    // Claude Code reads project hooks from .claude/settings.json; its MCP file here is .mcp.json.
    argv: (p) => ["-p", p, "--allowedTools", "Bash"],
    options: (d) => ({ configDir: join(d, ".claude"), stateFile: join(d, ".mcp.json") }),
  },
  {
    agent: "gemini-cli",
    mod: gemini as never,
    bin: "gemini",
    argv: (p) => ["-p", p, "--yolo"],
    options: (d) => ({ settingsFile: join(d, ".gemini", "settings.json") }),
  },
  {
    agent: "opencode",
    mod: opencode as never,
    bin: "opencode",
    argv: (p) => ["run", p],
    // OpenCode loads project plugins from <project>/{plugin,plugins}/*.ts and project config
    // from <project>/opencode.json, so the "config dir" is the project itself.
    options: (d) => ({ configDir: d }),
  },
  {
    agent: "cursor",
    mod: cursor as never,
    bin: "cursor-agent",
    argv: (p) => ["-p", p, "--force", "--trust"],
    options: (d) => ({ configDir: join(d, ".cursor") }),
  },
  {
    agent: "codex",
    mod: codex as never,
    bin: "codex",
    argv: (p) => ["exec", "--dangerously-bypass-hook-trust", p],
    options: (d) => ({ configDir: join(d, ".codex") }),
    note: "project hooks need a trusted project layer; the run passes --dangerously-bypass-hook-trust",
  },
  {
    agent: "copilot-cli",
    mod: copilot as never,
    bin: "copilot",
    argv: (p) => ["-p", p, "--allow-all-tools"],
    // Copilot reads its user config (hooks/ and mcp-config.json) from $COPILOT_HOME.
    options: (d) => ({ copilotHome: join(d, ".copilot") }),
    env: (d) => ({ COPILOT_HOME: join(d, ".copilot") }),
  },
];

export interface Prepared {
  dir: string;
  home: string;
  env: Record<string, string>;
  problems: string[];
  cleanup: () => void;
}

/** A throwaway repo whose project-level config points at `dist/` of this checkout. */
export function prepare(
  a: AgentE2E,
  sieveBin = join(REPO, "dist", "sieve"),
  shim = join(REPO, "dist", "sieve-hook"),
): Prepared {
  const dir = mkdtempSync("/tmp/sv-e2e-");
  const home = join(dir, "sieve-home");
  mkdirSync(home);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const opts = {
    shimPath: shim,
    sievePath: sieveBin,
    backupRoot: join(home, "backups"),
    ...a.options(dir),
  } as BaseSetupOptions;
  const spec = a.mod.setupSpec as unknown as AgentSetup<BaseSetupOptions>;
  const r = applySetup(spec, opts);
  const problems = r.rolledBack ? [r.error ?? "setup rolled back"] : spec.verify(opts);
  return {
    dir,
    home,
    env: {
      ...(process.env as Record<string, string>),
      SIEVE_HOME: home,
      SIEVE_BIN: sieveBin,
      ...(a.env?.(dir) ?? {}),
    },
    problems,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Names the agent uses for the event that follows a tool call. */
export function toolAfterNames(a: AgentE2E): string[] {
  const table = a.mod.HOOK_EVENTS ?? a.mod.EVENTS ?? {};
  return Object.entries(table)
    .filter(([, kind]) => kind === "tool.after")
    .map(([name]) => name);
}

export interface E2EResult {
  agent: string;
  agentVersion: string;
  at: string;
  passed: boolean;
  events: Array<{ event: string; count: number }>;
  reason: string;
}

export function judge(a: AgentE2E, status: StatusReport | null, version: string, at = new Date()): E2EResult {
  // `sieve status --json` with no daemon reports {daemon: null, setup} and no agents list.
  const s = status?.agents?.find((x) => x.agent === a.agent);
  const events = s?.events.map((e) => ({ event: e.event, count: e.count })) ?? [];
  const after = toolAfterNames(a);
  const sawAfter = events.some((e) => after.includes(e.event) && e.count > 0);
  const reason = !s
    ? "no hook reached the daemon"
    : !sawAfter
      ? `hooks fired (${events.map((e) => e.event).join(", ")}) but none of ${after.join("/")} after the tool call`
      : "hooks fired, including the one after a tool call";
  return {
    agent: a.agent,
    agentVersion: version,
    at: at.toISOString(),
    passed: !!s && sawAfter,
    events,
    reason,
  };
}

/**
 * Run a command with stdout and stderr going to a file, not a pipe. A pipe makes the child
 * write into a reader that may already be gone (EPIPE, seen from a CLI that then crashed with
 * an unhandled error); a file cannot. The file's contents are what the summary shows.
 */
export function run(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  ms: number,
  logFile: string,
): Promise<{ code: number | null; out: string }> {
  return new Promise((res) => {
    const fd = openSync(logFile, "w");
    // A missing binary emits both "error" and "close"; only the first may close the file.
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      closeSync(fd);
      let out = "";
      try {
        out = readFileSync(logFile, "utf8");
      } catch {}
      res({ code, out });
    };
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn(cmd, args, { cwd, env, stdio: ["ignore", fd, fd] });
    } catch {
      return finish(null);
    }
    const t = setTimeout(() => p.kill("SIGKILL"), ms);
    p.on("close", (code) => {
      clearTimeout(t);
      finish(code);
    });
    p.on("error", () => {
      clearTimeout(t);
      finish(null);
    });
  });
}

export async function runAgentE2E(
  a: AgentE2E,
  opts: { run: boolean; record?: string },
): Promise<E2EResult | null> {
  const sieve = join(REPO, "dist", "sieve");
  if (!existsSync(sieve)) throw new Error("run `bun run build` first");
  const bin = Bun.which(a.bin);
  const prep = prepare(a);
  try {
    console.log(`${a.agent}: project config written under ${prep.dir}`);
    if (prep.problems.length) {
      console.log(`${a.agent}: setup check failed:\n  - ${prep.problems.join("\n  - ")}`);
      return null;
    }
    console.log(
      `${a.agent}: command: ${a.bin} ${a
        .argv(PROMPT)
        .map((x) => JSON.stringify(x))
        .join(" ")}${a.note ? `\n  note: ${a.note}` : ""}`,
    );
    if (!opts.run) {
      console.log(`${a.agent}: dry run (add --run to spend one model call on your ${a.agent} account)`);
      return null;
    }
    if (!bin) {
      console.log(`${a.agent}: ${a.bin} is not installed here; nothing run`);
      return null;
    }
    const version =
      (await run(bin, ["--version"], prep.env, prep.dir, 20_000, join(prep.dir, "version.log"))).out
        .trim()
        .split("\n")[0] ?? "";
    const log = join(prep.dir, "agent.log");
    const r = await run(bin, a.argv(PROMPT), prep.env, prep.dir, 180_000, log);
    console.log(
      `${a.agent}: exited ${r.code}; last output: ${r.out.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`,
    );
    const st = await run(
      sieve,
      ["status", "--json"],
      prep.env,
      prep.dir,
      15_000,
      join(prep.dir, "status.log"),
    );
    let status: StatusReport | null = null;
    try {
      status = JSON.parse(st.out) as StatusReport;
    } catch {
      console.log(`${a.agent}: could not read sieve status: ${st.out.trim().slice(0, 200)}`);
    }
    await run(sieve, ["daemon", "stop"], prep.env, prep.dir, 10_000, join(prep.dir, "stop.log"));
    const result = judge(a, status, version);
    console.log(`${a.agent}: ${result.passed ? "PASS" : "FAIL"}: ${result.reason}`);
    if (opts.record) {
      mkdirSync(opts.record, { recursive: true });
      writeFileSync(join(opts.record, `${a.agent}.json`), `${JSON.stringify(result, null, 2)}\n`);
    }
    return result;
  } finally {
    prep.cleanup();
  }
}
