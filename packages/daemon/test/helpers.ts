import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

export const REPO = resolve(import.meta.dir, "../../..");
export const SHIM = join(REPO, "dist", "sieve-hook");
export const SIEVE = join(REPO, "dist", "sieve");

/** A fresh SIEVE_HOME with a short path (Unix socket paths are limited to ~104 bytes). */
export function freshHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync("/tmp/sv-");
  process.env.SIEVE_HOME = home;
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** Async on purpose: the daemon under test may live in this same process. */
export async function runShim(input: unknown, env: Record<string, string> = {}, event = "PostToolUse") {
  const t0 = performance.now();
  const p = Bun.spawn([SHIM, "claude-code", event], {
    stdin: Buffer.from(typeof input === "string" ? input : JSON.stringify(input)),
    stdout: "pipe",
    env: { ...process.env, ...env },
  });
  const stdout = await new Response(p.stdout).text();
  const code = await p.exited;
  return { code, stdout, ms: performance.now() - t0 };
}

export function bashPost(stdout: string, cwd: string, extra: Record<string, unknown> = {}) {
  return {
    session_id: "sess-1",
    cwd,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "npm test", description: "Run the test suite" },
    tool_response: { stdout, stderr: "", interrupted: false, isImage: false },
    ...extra,
  };
}

export function bigOutput(lines = 3000): string {
  return Array.from(
    { length: lines },
    (_, i) => `PASS src/feature${i}/widget.test.ts (${(i % 97) + 3} ms)`,
  ).join("\n");
}
