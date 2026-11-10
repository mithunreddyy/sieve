import { appendFileSync, mkdirSync } from "node:fs";
import { paths } from "@sieve/core";
import { DaemonClient, spawnDaemon } from "@sieve/daemon";
import type { HookResult } from "@sieve/protocol";

/**
 * TypeScript fallback for the Go shim (`sieve hook <agent> [event]`). Same contract: never
 * block, never fail the agent. Slower to start than the Go shim, so setup prefers the shim.
 */
export async function runHook(agent: string, event: string): Promise<number> {
  const raw = await Bun.stdin.text();
  const timeoutMs = Number(process.env.SIEVE_HOOK_TIMEOUT_MS ?? 250);
  const miss = (reason: string) => {
    try {
      mkdirSync(paths.runDir(), { recursive: true, mode: 0o700 });
      appendFileSync(paths.misses(), `${Date.now()}\t${agent}\t${event}\t${reason}\n`);
    } catch {}
    return 0;
  };
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return miss("bad-input");
  }
  const client = await DaemonClient.tryConnect(paths.socket(), timeoutMs);
  if (!client) {
    spawnDaemon();
    return miss("daemon-down");
  }
  const reply = await client.request(
    { type: "hook", agent, event, input, client: "sieve-hook-ts", budgetMs: timeoutMs },
    timeoutMs,
  );
  client.close();
  if (!reply.ok)
    return miss(
      reply.error.code === "internal" && reply.error.message === "timed out" ? "timeout" : reply.error.code,
    );
  const r = reply.result as HookResult;
  if (r.stdout) process.stdout.write(r.stdout);
  return r.exitCode;
}
