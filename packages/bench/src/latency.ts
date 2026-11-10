import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../../..");
const SHIM = join(REPO, "dist", "sieve-hook");
const SIEVE = join(REPO, "dist", "sieve");

export interface LatencyRow {
  case: string;
  n: number;
  /** How many calls got a reply (a fold, a declined read, context) rather than a pass-through. */
  replied: number;
  p50: number;
  p99: number;
  max: number;
}

function pct(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]! * 100) / 100;
}

async function call(
  cmd: string[],
  input: string,
  env: Record<string, string>,
): Promise<{ ms: number; out: string }> {
  const t0 = performance.now();
  const p = Bun.spawn(cmd, {
    stdin: Buffer.from(input),
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, ...env },
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return { ms: performance.now() - t0, out };
}

/**
 * End-to-end hook latency as the agent sees it: process exec of the shim → daemon → stdout.
 * Warm = daemon running. Cold = no daemon (the shim passes through and starts one).
 */
export async function runLatency(n = 300): Promise<LatencyRow[]> {
  if (!existsSync(SHIM) || !existsSync(SIEVE)) throw new Error("run `bun run build` first");
  const home = mkdtempSync("/tmp/svb-");
  const env = { SIEVE_HOME: home, SIEVE_BIN: SIEVE, SIEVE_HOOK_TIMEOUT_MS: "1000" };
  const cwd = join(home);
  const small = JSON.stringify({
    session_id: "b",
    cwd,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  });
  const big = (i: number) =>
    JSON.stringify({
      session_id: "b",
      cwd,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test", description: "run tests" },
      tool_response: {
        stdout: Array.from({ length: 1500 }, (_, k) => `PASS case ${k} iteration ${i} (${k % 13} ms)`).join(
          "\n",
        ),
        stderr: "",
        interrupted: false,
      },
    });
  const repo = join(home, "repo");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(repo);
  writeFileSync(
    join(repo, "routes.ts"),
    Array.from(
      { length: 1800 },
      (_, i) => `export function handler${i}(req: Request) { return limitRate(req, ${i}); }`,
    ).join("\n"),
  );
  const readPre = JSON.stringify({
    session_id: "b",
    cwd: repo,
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: join(repo, "routes.ts") },
  });
  const rows: LatencyRow[] = [];
  const measure = async (name: string, cmd: string[], input: (i: number) => string, count: number) => {
    const xs: number[] = [];
    let replied = 0;
    for (let i = 0; i < count; i++) {
      const r = await call(cmd, input(i), env);
      xs.push(r.ms);
      if (r.out.trim()) replied++;
    }
    rows.push({
      replied,
      case: name,
      n: count,
      p50: pct(xs, 0.5),
      p99: pct(xs, 0.99),
      max: Math.round(Math.max(...xs) * 100) / 100,
    });
  };
  try {
    // Cold: no daemon. Measures the pass-through path including the detached spawn.
    await measure(
      "go shim, cold (no daemon, pass-through)",
      [SHIM, "claude-code", "PreToolUse"],
      () => small,
      1,
    );
    for (let i = 0; i < 100 && !existsSync(join(home, "run", "sieved.sock")); i++) await Bun.sleep(20);
    for (let i = 0; i < 20; i++) await call([SHIM, "claude-code", "PreToolUse"], small, env); // warm up
    await measure("go shim, warm, PreToolUse (small)", [SHIM, "claude-code", "PreToolUse"], () => small, n);
    await measure(
      "go shim, warm, PostToolUse 60 KB → receipt",
      [SHIM, "claude-code", "PostToolUse"],
      big,
      Math.min(n, 100),
    );
    await measure(
      "go shim, warm, PreToolUse Read 100 KB file (outline / pass)",
      [SHIM, "claude-code", "PreToolUse"],
      () => readPre,
      Math.min(n, 100),
    );
    await measure(
      "ts fallback (sieve hook), warm, PreToolUse",
      [SIEVE, "hook", "claude-code", "PreToolUse"],
      () => small,
      20,
    );
  } finally {
    await call([SIEVE, "daemon", "stop"], "", env);
    await Bun.sleep(100);
    rmSync(home, { recursive: true, force: true });
  }
  return rows;
}
