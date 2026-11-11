import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { paths } from "@sieve/core";

/**
 * What every adapter's `sieve setup` shares: plan the file changes, back up every file it
 * touches, write atomically, check the result, and roll back that agent if the check fails.
 */

export interface FileChange {
  file: string;
  before: string | null;
  after: string;
  summary: string[];
  /** Delete the file instead of writing `after` (removal of a file Sieve created). */
  delete?: boolean;
}

export interface SetupResult {
  changes: FileChange[];
  backupDir: string | null;
  verified: boolean;
  rolledBack: boolean;
  error?: string;
}

export interface BaseSetupOptions {
  /** Absolute path of the sieve-hook shim */
  shimPath: string;
  /** Absolute path of the sieve binary (for MCP server entries) */
  sievePath: string;
  /** Extra args before "mcp", e.g. a script path when running from source */
  sieveArgs?: string[];
  backupRoot?: string;
  now?: Date;
  /** Home directory to look in (tests); default os.homedir() */
  home?: string;
}

/** One agent's setup, as the CLI drives it. */
export interface AgentSetup<O extends BaseSetupOptions = BaseSetupOptions> {
  agent: string;
  /** See AgentCapabilities.support. */
  support: "verified" | "live" | "preview";
  /** Is the agent installed for this user? */
  detect(home?: string): boolean;
  plan(opts: O, remove?: boolean): FileChange[];
  /** A step only the user can do, printed after setup (e.g. trusting hooks inside the agent). */
  after?: string;
  /** Problems with the current config; empty means it points at Sieve. */
  verify(opts: O): string[];
}

export const stringify = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

export const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);

export function readJson(file: string): { text: string | null; value: Record<string, unknown> } {
  if (!existsSync(file)) return { text: null, value: {} };
  const text = readFileSync(file, "utf8");
  const value = text.trim() ? JSON.parse(text) : {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${file} is not a JSON object`);
  return { text, value };
}

/**
 * Read a JSON file that may hold comments and trailing commas (Zed, VS Code style). For checks only:
 * Sieve never writes such a file back, because re-serialising would drop the user's comments.
 * `strict` is false when plain JSON.parse would have failed.
 */
export function readJsonc(file: string): { value: Record<string, unknown>; strict: boolean } {
  if (!existsSync(file)) return { value: {}, strict: true };
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return { value: {}, strict: true };
  let strict = true;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    strict = false;
    value = Bun.JSONC.parse(text);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${file} is not a JSON object`);
  return { value: value as Record<string, unknown>, strict };
}

/** A JSON file change, or null when the content would not change. */
export function jsonChange(
  file: string,
  before: { text: string | null; value: unknown },
  after: unknown,
  summary: string[],
  remove: boolean,
): FileChange | null {
  if (before.text === null && remove) return null;
  // Key order is not a change: removing and re-adding Sieve's entries can move a key.
  if (before.text !== null && canonical(before.value) === canonical(after)) return null;
  return { file, before: before.text, after: stringify(after), summary };
}

/** JSON with object keys sorted, for comparing content regardless of key order. */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, (x as Record<string, unknown>)[k]]),
        )
      : x,
  );
}

function atomicWrite(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.sieve-tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/**
 * Apply an agent's setup (or removal). Every touched file is backed up first. If the check
 * after writing fails, every file is restored and the result says so. Running twice changes
 * nothing the second time.
 */
export function applySetup<O extends BaseSetupOptions>(
  s: AgentSetup<O>,
  opts: O,
  remove = false,
): SetupResult {
  const changes = s.plan(opts, remove);
  if (changes.length === 0)
    return { changes, backupDir: null, verified: remove || s.verify(opts).length === 0, rolledBack: false };
  const stamp = (opts.now ?? new Date()).toISOString().replaceAll(":", "-");
  // Never reuse a backup folder: a second run in the same millisecond must not overwrite the
  // first, which may hold the only copy of the user's original config.
  const root = join(opts.backupRoot ?? paths.backupsDir(), stamp);
  let backupDir = join(root, s.agent);
  for (let n = 1; existsSync(backupDir); n++) backupDir = join(root, `${s.agent}-${n}`);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const manifest: Array<{ file: string; backup: string | null }> = [];
  for (const c of changes) {
    let backup: string | null = null;
    if (c.before !== null) {
      backup = join(backupDir, `${manifest.length}-${basename(c.file)}`);
      copyFileSync(c.file, backup);
    }
    manifest.push({ file: c.file, backup });
  }
  writeFileSync(join(backupDir, "manifest.json"), stringify(manifest));
  const rollback = () => {
    for (const m of manifest) {
      if (m.backup) copyFileSync(m.backup, m.file);
      else if (existsSync(m.file)) unlinkSync(m.file); // it did not exist before setup
    }
  };
  try {
    for (const c of changes) {
      if (c.delete) {
        if (existsSync(c.file)) unlinkSync(c.file);
      } else atomicWrite(c.file, c.after);
    }
  } catch (e) {
    rollback();
    return { changes, backupDir, verified: false, rolledBack: true, error: (e as Error).message };
  }
  if (remove) return { changes, backupDir, verified: true, rolledBack: false };
  const problems = s.verify(opts);
  if (problems.length) {
    rollback();
    return { changes, backupDir, verified: false, rolledBack: true, error: problems.join("; ") };
  }
  return { changes, backupDir, verified: true, rolledBack: false };
}

/** Restore the files recorded in a backup folder made by applySetup. */
export function restoreBackup(backupDir: string): string[] {
  const manifest = JSON.parse(readFileSync(join(backupDir, "manifest.json"), "utf8")) as Array<{
    file: string;
    backup: string | null;
  }>;
  const restored: string[] = [];
  for (const m of manifest) {
    if (m.backup) {
      copyFileSync(m.backup, m.file);
      restored.push(m.file);
    }
  }
  return restored;
}

// ------------------------------------------------------------------ hook-groups settings
// Claude Code, Gemini CLI and Qwen Code all keep hooks as
// { hooks: { <Event>: [ { matcher?, hooks: [ { type: "command", command, timeout } ] } ] } }.

export type HookGroup = {
  matcher?: string;
  hooks: Array<{ type: string; command?: string; timeout?: number; name?: string }>;
} & Record<string, unknown>;
export type HookSettings = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

/** Does a hook command run sieve-hook for this agent? */
export function isSieveHook(cmd: unknown, agent: string): boolean {
  return typeof cmd === "string" && new RegExp(`sieve-hook['"]?\\s+${agent}\\b`).test(cmd);
}

export function hookCommand(shimPath: string, agent: string, event: string): string {
  return `${shellQuote(shimPath)} ${agent} ${event}`;
}

/** Remove Sieve's hook entries for an agent, leaving every other entry exactly as it was. */
export function stripHooks(settings: HookSettings, agent: string): HookSettings {
  if (!settings.hooks) return settings;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = (groups ?? [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isSieveHook(h.command, agent)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
  }
  const out: HookSettings = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete out.hooks;
  return out;
}

export interface HookSpec {
  event: string;
  matcher?: string;
  /** Timeout in the agent's own unit (Claude Code: seconds; Gemini/Qwen: milliseconds). */
  timeout: number;
  name?: string;
}

/** Settings with Sieve's hooks (re)added at the end of each event's list. */
export function withHooks(
  settings: HookSettings,
  agent: string,
  shimPath: string,
  specs: HookSpec[],
): HookSettings {
  const s = stripHooks(settings, agent);
  const hooks: Record<string, HookGroup[]> = { ...(s.hooks ?? {}) };
  for (const sp of specs) {
    const group: HookGroup = {
      ...(sp.matcher !== undefined ? { matcher: sp.matcher } : {}),
      hooks: [
        {
          ...(sp.name ? { name: sp.name } : {}),
          type: "command",
          command: hookCommand(shimPath, agent, sp.event),
          timeout: sp.timeout,
        },
      ],
    };
    hooks[sp.event] = [...(hooks[sp.event] ?? []), group];
  }
  return { ...s, hooks };
}

/** Events whose Sieve hook is missing from the settings. */
export function missingHooks(settings: HookSettings, agent: string, events: string[]): string[] {
  return events.filter((ev) => {
    const cmds = (settings.hooks?.[ev] ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command);
    return !cmds.some((c) => isSieveHook(c, agent));
  });
}

/**
 * The command to print as the fix for an agent's config problems. A problem can name its own fix
 * after a final ": " (the Claude Code plugin's do: "run /sieve:install", "sieve setup --remove …");
 * otherwise it is re-running setup for that agent.
 */
export function fixFor(agent: string, problems: string[]): string {
  for (const p of problems) {
    const m = /: (?:run )?((?:\/sieve:|sieve )[^;]+)$/.exec(p);
    if (m) return m[1]!;
  }
  return `sieve setup --agents ${agent}`;
}
