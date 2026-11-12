import { existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { applyPurge, ProjectStore, type PurgeScope, paths, planPurge, resolveProject } from "@sieve/core";
import { acquireLock, DaemonClient } from "@sieve/daemon";
import { flag, has } from "./args.ts";

/**
 * `sieve purge`: remove archived output on purpose (docs: ADR 0018). A dry run unless `--yes`.
 * With `--yes` the daemon is stopped first (it holds open connections and indexing state for the
 * database), the rows are removed, and the file is compacted before anything is said to be gone.
 */

const USAGE =
  "usage: sieve purge --session <id> | --project | --older-than <days>  [--path <dir>] [--yes]\n" +
  "  --session <id>     what only that session saw (see: sieve session list)\n" +
  "  --project          everything archived for this project\n" +
  "  --older-than <n>   items not read for n days\n" +
  "  A dry run unless you add --yes.";

const size = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const fileBytes = (f: string) =>
  [f, `${f}-wal`].reduce((n, x) => n + (existsSync(x) ? statSync(x).size : 0), 0);

/** Stop the daemon and wait until it has let go of its lock. False if it would not stop. */
async function stopDaemon(): Promise<boolean> {
  const c = await DaemonClient.tryConnect();
  if (!c) return true;
  try {
    await c.request({ type: "shutdown" });
  } catch {}
  c.close();
  for (let i = 0; i < 100 && existsSync(paths.lock()); i++) await Bun.sleep(100);
  return !existsSync(paths.lock());
}

/** `hooks.afterStop` is for tests: it runs in the window after the daemon stopped and before any row is deleted. */
export async function purgeCommand(
  args: string[],
  cwd = process.cwd(),
  hooks: { afterStop?: () => Promise<void> } = {},
): Promise<number> {
  const yes = has(args, "--yes");
  const path = flag(args, "--path");
  const session = flag(args, "--session");
  const project = has(args, "--project");
  const older = flag(args, "--older-than");
  const chosen = [session !== undefined, project, older !== undefined].filter(Boolean).length;
  if (chosen !== 1 || args.length) {
    console.error(USAGE);
    return 2;
  }
  let scope: PurgeScope;
  if (session !== undefined) {
    if (!session) {
      console.error("--session needs an id (see: sieve session list)");
      return 2;
    }
    scope = { kind: "session", sessionId: session };
  } else if (older !== undefined) {
    const days = Number(older);
    if (!/^\d+$/.test(older) || !Number.isInteger(days) || days < 1) {
      console.error(`--older-than needs a whole number of days, 1 or more (got "${older}")`);
      return 2;
    }
    scope = { kind: "older", days };
  } else scope = { kind: "project" };

  const ref = resolveProject(path ?? cwd);
  const file = paths.projectDb(ref.key);
  if (!existsSync(file)) {
    console.log(`Nothing is archived for project ${ref.name}.`);
    return 0;
  }
  const what = (p: { items: number; bytes: number; chunks: number; rows: number }) =>
    `${plural(p.items, "archived item")} (${size(p.bytes)}), ${plural(p.chunks, "search chunk")}${p.rows ? `, and ${plural(p.rows, "session record")}` : ""} from project ${ref.name}`;

  if (!yes) {
    const store = new ProjectStore(ref, file);
    try {
      console.log(`Would remove ${what(planPurge(store, scope))}.`);
    } finally {
      store.close();
    }
    console.log("Nothing was changed. Run it again with --yes to remove it.");
    return 0;
  }

  if (!(await stopDaemon())) {
    console.error(
      "The daemon is still running and holds this database. Stop it with `sieve daemon stop` and try again.",
    );
    return 1;
  }
  // Hold the daemon's lock for the whole operation. Without it, the next hook from any open agent
  // session would start a daemon that opens this database while rows are being deleted.
  mkdirSync(paths.runDir(), { recursive: true, mode: 0o700 }); // the daemon does this before taking the lock
  if (!acquireLock(paths.lock())) {
    console.error("A daemon started again before the purge could begin. Try again.");
    return 1;
  }
  const before = fileBytes(file);
  let store: ProjectStore | undefined;
  try {
    await hooks.afterStop?.();
    store = new ProjectStore(ref, file);
    const done = applyPurge(store, scope, "purge");
    store.compact();
    console.log(`Removed ${what(done)}.`);
    console.log(`The database was compacted: ${size(before)} → ${size(fileBytes(file))}.`);
  } finally {
    store?.close();
    try {
      if (readFileSync(paths.lock(), "utf8").trim() === String(process.pid)) unlinkSync(paths.lock());
    } catch {}
    // Every hook that fired meanwhile tried to start a daemon and was turned away. Forget those, or
    // the shim's crash-loop cap would stop it starting one for 5 minutes.
    rmSync(join(paths.runDir(), "spawns"), { force: true });
  }
  console.log(
    "Not touched: memory facts (sieve memory); the proxy's own archive (sieve proxy); session exports and sync folders you made; any backup of ~/.sieve you keep; the Guard audit log and the daemon log (rule names, paths and lifecycle lines, not output); and the agent's own copies: Claude Code keeps every tool result in its transcript and tool-results files, which Sieve reads but does not own.",
  );
  console.log(
    "A receipt that names a removed id now says it was removed. The daemon restarts on the next hook.",
  );
  return 0;
}
