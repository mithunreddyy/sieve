import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { paths } from "@sieve/core";

export interface ClaudeSetupOptions {
  /** Claude Code config dir (default: $CLAUDE_CONFIG_DIR or ~/.claude) */
  configDir?: string;
  /** Path of the user-level Claude state file holding mcpServers (default: ~/.claude.json) */
  stateFile?: string;
  /** Absolute path of the sieve-hook shim */
  shimPath: string;
  /** Absolute path of the sieve binary (for the MCP server entry) */
  sievePath: string;
  /** Extra args before "mcp", e.g. a script path when running from source */
  sieveArgs?: string[];
  backupRoot?: string;
  now?: Date;
}

export interface FileChange {
  file: string;
  before: string | null;
  after: string;
  summary: string[];
}

export interface SetupResult {
  changes: FileChange[];
  backupDir: string | null;
  verified: boolean;
  rolledBack: boolean;
  error?: string;
}

const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "SubagentStart",
  "Stop",
  "SessionEnd",
] as const;
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);
const MCP_NAME = "sieve";

function resolveOpts(o: ClaudeSetupOptions) {
  const configDir = o.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const stateFile =
    o.stateFile ??
    (process.env.CLAUDE_CONFIG_DIR ? join(configDir, ".claude.json") : join(homedir(), ".claude.json"));
  return { ...o, configDir, stateFile, settingsFile: join(configDir, "settings.json") };
}

const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);

export function hookCommand(shimPath: string, event: string): string {
  return `${shellQuote(shimPath)} claude-code ${event}`;
}

/** A hook entry belongs to Sieve if its command runs a sieve-hook binary for claude-code. */
export function isSieveHook(cmd: unknown): boolean {
  return typeof cmd === "string" && /sieve-hook['"]?\s+claude-code\b/.test(cmd);
}

type HookGroup = { matcher?: string; hooks: Array<{ type: string; command?: string; timeout?: number }> };
type Settings = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

function readJson(file: string): { text: string | null; value: Record<string, unknown> } {
  if (!existsSync(file)) return { text: null, value: {} };
  const text = readFileSync(file, "utf8");
  const value = text.trim() ? JSON.parse(text) : {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${file} is not a JSON object`);
  return { text, value };
}

/** Remove Sieve's hook entries, leaving every other entry exactly as it was. */
function stripSieve(settings: Settings): Settings {
  if (!settings.hooks) return settings;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = (groups ?? [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isSieveHook(h.command)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
  }
  const out: Settings = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete out.hooks;
  return out;
}

function withSieve(settings: Settings, shimPath: string): Settings {
  const s = stripSieve(settings);
  const hooks: Record<string, HookGroup[]> = { ...(s.hooks ?? {}) };
  for (const ev of EVENTS) {
    const group: HookGroup = {
      ...(TOOL_EVENTS.has(ev) ? { matcher: "*" } : {}),
      hooks: [{ type: "command", command: hookCommand(shimPath, ev), timeout: 5 }],
    };
    hooks[ev] = [...(hooks[ev] ?? []), group];
  }
  return { ...s, hooks };
}

const stringify = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** Compute the changes `sieve setup` would make, without writing anything. */
export function planSetup(opts: ClaudeSetupOptions, remove = false): FileChange[] {
  const o = resolveOpts(opts);
  const changes: FileChange[] = [];

  const settings = readJson(o.settingsFile);
  const nextSettings = remove
    ? stripSieve(settings.value as Settings)
    : withSieve(settings.value as Settings, o.shimPath);
  const settingsAfter = stringify(nextSettings);
  if (settings.text === null ? !remove : JSON.stringify(settings.value) !== JSON.stringify(nextSettings)) {
    changes.push({
      file: o.settingsFile,
      before: settings.text,
      after: settingsAfter,
      summary: remove
        ? ["remove Sieve hook entries"]
        : EVENTS.map((e) => `hook ${e} → ${hookCommand(o.shimPath, e)}`),
    });
  }

  const state = readJson(o.stateFile);
  const servers = { ...((state.value.mcpServers as Record<string, unknown>) ?? {}) };
  const desired = { type: "stdio", command: o.sievePath, args: [...(o.sieveArgs ?? []), "mcp"], env: {} };
  if (remove) delete servers[MCP_NAME];
  else servers[MCP_NAME] = desired;
  const nextState = { ...state.value, mcpServers: servers };
  if (remove && Object.keys(servers).length === 0) delete (nextState as Record<string, unknown>).mcpServers;
  if (JSON.stringify(state.value) !== JSON.stringify(nextState) && !(remove && state.text === null)) {
    changes.push({
      file: o.stateFile,
      before: state.text,
      after: stringify(nextState),
      summary: [remove ? `remove MCP server "${MCP_NAME}"` : `MCP server "${MCP_NAME}" → ${o.sievePath} mcp`],
    });
  }
  return changes;
}

/** Check that Claude Code's config points at Sieve. Returns problems; empty means healthy. */
export function verifySetup(opts: ClaudeSetupOptions): string[] {
  const o = resolveOpts(opts);
  const problems: string[] = [];
  let settings: Settings;
  try {
    settings = readJson(o.settingsFile).value as Settings;
  } catch (e) {
    return [`cannot read ${o.settingsFile}: ${(e as Error).message}`];
  }
  for (const ev of EVENTS) {
    const cmds = (settings.hooks?.[ev] ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command);
    if (!cmds.some(isSieveHook)) problems.push(`hook ${ev} is not registered`);
  }
  if (!existsSync(o.shimPath)) problems.push(`shim not found at ${o.shimPath}`);
  try {
    const servers = readJson(o.stateFile).value.mcpServers as
      | Record<string, { command?: string }>
      | undefined;
    const entry = servers?.[MCP_NAME];
    if (!entry) problems.push(`MCP server "${MCP_NAME}" is not registered`);
    else if (entry.command && !existsSync(entry.command))
      problems.push(`MCP command not found: ${entry.command}`);
  } catch (e) {
    problems.push(`cannot read ${o.stateFile}: ${(e as Error).message}`);
  }
  return problems;
}

function atomicWrite(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.sieve-tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/**
 * Apply setup (or removal). Every touched file is backed up first. If the post-write check
 * fails, every file is restored and the result says so. Running it twice changes nothing.
 */
export function applySetup(opts: ClaudeSetupOptions, remove = false): SetupResult {
  const changes = planSetup(opts, remove);
  if (changes.length === 0) {
    return {
      changes,
      backupDir: null,
      verified: remove || verifySetup(opts).length === 0,
      rolledBack: false,
    };
  }
  const stamp = (opts.now ?? new Date()).toISOString().replaceAll(":", "-");
  const backupDir = join(opts.backupRoot ?? paths.backupsDir(), stamp, "claude-code");
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
    for (const c of changes) atomicWrite(c.file, c.after);
  } catch (e) {
    rollback();
    return { changes, backupDir, verified: false, rolledBack: true, error: (e as Error).message };
  }
  if (remove) return { changes, backupDir, verified: true, rolledBack: false };
  const problems = verifySetup(opts);
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
