import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fixFor } from "@sieve/adapter-kit";
import { paths } from "@sieve/core";

/**
 * OS notification when an installed agent no longer points at Sieve (slice 12). Silent bypass is the
 * failure this prevents: the agent keeps working, Sieve just stops seeing it.
 *
 * `sieve notify-check` compares each detected agent's config with what setup wrote and sends one
 * notification per new problem (remembered in run/notified.json, so it does not repeat). The daemon
 * runs it every few minutes when `[notify] enabled = true` (off by default).
 */

export type Notifier = (title: string, body: string) => void;

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export const osNotifier: Notifier = (title, body) => {
  if (process.platform === "darwin")
    execFileSync("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`], {
      stdio: "ignore",
    });
  else if (process.platform === "linux") execFileSync("notify-send", [title, body], { stdio: "ignore" });
  else throw new Error(`no notifier for ${process.platform}`);
};

const stateFile = () => join(paths.runDir(), "notified.json");

function seenBefore(file: string): Set<string> {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return new Set(Array.isArray(j) ? j.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * Tell the user about problems not yet reported. Problems that went away are forgotten, so a
 * problem that comes back is reported again. Returns the lines it reported.
 */
export function notifyProblems(
  checks: Array<{ agent: string; problems: string[] }>,
  notify: Notifier = osNotifier,
  file = stateFile(),
): string[] {
  const now = new Set<string>();
  const sent: string[] = [];
  const before = existsSync(file) ? seenBefore(file) : new Set<string>();
  for (const c of checks)
    for (const p of c.problems) {
      const key = `${c.agent}|${p}`;
      now.add(key);
      if (before.has(key)) continue;
      const line = `${c.agent}: ${p}`;
      try {
        notify("Sieve is not seeing this agent", `${line}. Run: ${fixFor(c.agent, [p])}`);
        sent.push(line);
      } catch {
        now.delete(key); // could not tell the user: try again next time
      }
    }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify([...now]));
  return sent;
}
