import type { ProjectStore } from "@sieve/core";
import { type Analysis, analyze, type Facts } from "@sieve/guard";
import type { DaemonContext } from "./context.ts";

/**
 * Steering (slice 9): a read-only command that printed a lot last time is declined once, with
 * a `sieve_run` call that prints less. The same call sent again goes through.
 *
 * It only acts on commands it can prove are read-only (a short allow-list, no redirects, no
 * writes, no network), and only when the history says it pays: the tokens a shorter result
 * would save must exceed twice the cost of the extra model call the decline causes.
 */

/** What one extra model call costs in tokens: the decline message, the retry and its reply. */
export const EXTRA_CALL_TOKENS = 1500;
/** What a `sieve_run` receipt of a big output typically costs. */
export const RECEIPT_TOKENS = 800;

const SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  git: new Set([
    "log",
    "diff",
    "show",
    "status",
    "blame",
    "ls-files",
    "grep",
    "shortlog",
    "describe",
    "ls-tree",
  ]),
  docker: new Set(["logs", "ps", "images", "inspect", "history"]),
  podman: new Set(["logs", "ps", "images", "inspect"]),
  kubectl: new Set(["get", "logs", "describe", "top"]),
  npm: new Set(["ls", "list", "outdated", "view", "audit"]),
  pnpm: new Set(["ls", "list", "outdated"]),
  pip: new Set(["list", "freeze", "show"]),
  cargo: new Set(["tree", "metadata"]),
  go: new Set(["list"]),
  brew: new Set(["list", "info", "outdated"]),
};
const PLAIN = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "find",
  "tree",
  "wc",
  "ps",
  "df",
  "du",
  "stat",
  "sort",
  "uniq",
  "awk",
  "sed",
  "cut",
  "tac",
  "nl",
  "lsof",
  "journalctl",
  "dmesg",
  "env",
  "printenv",
]);
/** Flags that turn an otherwise read-only program into one that acts. */
const ACTING_FLAGS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-fprint",
  "-fprintf",
  "-i",
  "--in-place",
  "-o",
  "--output",
]);

function readOnly(f: Facts): boolean {
  if (f.remote || f.wrappers.length) return false;
  if (f.hosts.length) return false;
  const sub = SUBCOMMANDS[f.program];
  if (sub) {
    if (!f.subcommand || !sub.has(f.subcommand)) return false;
  } else if (!PLAIN.has(f.program)) return false;
  // sed -i and friends write; find -delete removes; tee/output flags write
  if (f.flags.some((x) => ACTING_FLAGS.has(x)) || f.args.some((a) => ACTING_FLAGS.has(a))) return false;
  if (f.program === "sed" && f.flags.includes("-i")) return false;
  if (f.paths.some((p) => p.ops.some((o) => o !== "read" && o !== "list" && o !== "any"))) return false;
  return true;
}

export interface Steerable {
  /** `git log`, `ls`, `kubectl get`: the key the history is kept under. */
  family: string;
  analysis: Analysis;
}

/** The command's family if every part of it is provably read-only, else null. */
export function steerable(command: string, cwd?: string): Steerable | null {
  if (command.length > 2000 || /[\n]/.test(command.trim())) return null;
  let a: Analysis;
  try {
    a = analyze(command, cwd ? { cwd } : {});
  } catch {
    return null;
  }
  if (!a.commands.length || a.commands.length > 4 || a.truncated || a.patterns.length) return null;
  if (!a.commands.every(readOnly)) return null;
  const first = a.commands[0]!;
  return {
    family:
      SUBCOMMANDS[first.program] && first.subcommand ? `${first.program} ${first.subcommand}` : first.program,
    analysis: a,
  };
}

export function shouldSteer(lastTokens: number): boolean {
  return lastTokens - RECEIPT_TOKENS > 2 * EXTRA_CALL_TOKENS;
}

const TTL_MS = 10 * 60_000;

/**
 * The reason to give for declining this call, or null to let it through. A repeat of a call that
 * was just declined (same reader, same command) is always let through.
 */
export function steerBefore(
  ctx: DaemonContext,
  store: ProjectStore,
  worktree: string,
  reader: { sessionId: string; context: string },
  command: string,
  cwd: string,
  now = Date.now(),
): string | null {
  if (!ctx.config.steering.enabled) return null;
  const s = steerable(command, cwd);
  if (!s) return null;
  const key = `steer|${reader.sessionId}|${reader.context}|${worktree}|${command.trim()}`;
  const until = ctx.declines.get(key);
  if (until !== undefined && until >= now) {
    ctx.declines.delete(key);
    return null;
  }
  const stat = store.commandStat(worktree, s.family);
  if (!stat || !shouldSteer(stat.lastTokens)) return null;
  ctx.declines.set(key, now + TTL_MS);
  ctx.counters.steered++;
  const call = JSON.stringify({
    language: "shell",
    code: command.trim(),
    intent: "what the next step needs from this output",
  });
  return `[sieve] \`${s.family}\` printed about ${stat.lastTokens.toLocaleString("en-US")} tokens last time, which would sit in the context from here on. Run it through sieve_run instead, which keeps the lines that matter and archives the rest (expand with sieve_get): sieve_run ${call}. To see everything anyway, send the same command again and it will run.`;
}
