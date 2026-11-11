import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AgentSetup,
  type BaseSetupOptions,
  type FileChange,
  type HookSettings,
  jsonChange,
  applySetup as kitApply,
  hookCommand as kitHookCommand,
  isSieveHook as kitIsSieveHook,
  missingHooks,
  readJson,
  type SetupResult,
  stripHooks,
  withHooks,
} from "@sieve/adapter-kit";
import { sieveHome } from "@sieve/core";

export type { FileChange, SetupResult } from "@sieve/adapter-kit";
export { restoreBackup } from "@sieve/adapter-kit";

export interface ClaudeSetupOptions extends BaseSetupOptions {
  /** Claude Code config dir (default: $CLAUDE_CONFIG_DIR or ~/.claude) */
  configDir?: string;
  /** Path of the user-level Claude state file holding mcpServers (default: ~/.claude.json) */
  stateFile?: string;
  /** Where the Sieve plugin runs its binaries from (default: $SIEVE_HOME/bin) */
  pluginBinDir?: string;
}

const AGENT = "claude-code";
export const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "SubagentStart",
  "Stop",
  "SessionEnd",
] as const;
export const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);
const MCP_NAME = "sieve";

function resolveOpts(o: ClaudeSetupOptions) {
  const home = o.home ?? homedir();
  const configDir = o.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const stateFile =
    o.stateFile ??
    (process.env.CLAUDE_CONFIG_DIR ? join(configDir, ".claude.json") : join(home, ".claude.json"));
  return { ...o, configDir, stateFile, settingsFile: join(configDir, "settings.json") };
}

/**
 * The Sieve Claude Code plugin, if installed and not disabled: `sieve@<marketplace>` in
 * plugins/installed_plugins.json, and not `false` in settings.json's enabledPlugins.
 */
export function sievePlugin(configDir: string, settings: Record<string, unknown>): string | null {
  let installed: Record<string, unknown> = {};
  try {
    installed = (readJson(join(configDir, "plugins", "installed_plugins.json")).value.plugins ??
      {}) as Record<string, unknown>;
  } catch {
    return null;
  }
  const enabled = (settings.enabledPlugins ?? {}) as Record<string, unknown>;
  return Object.keys(installed).find((k) => k.startsWith("sieve@") && enabled[k] !== false) ?? null;
}

export const hookCommand = (shimPath: string, event: string) => kitHookCommand(shimPath, AGENT, event);
/** A hook entry belongs to Sieve if its command runs a sieve-hook binary for claude-code. */
export const isSieveHook = (cmd: unknown) => kitIsSieveHook(cmd, AGENT);

/** Compute the changes `sieve setup` would make, without writing anything. */
export function planSetup(opts: ClaudeSetupOptions, remove = false): FileChange[] {
  const o = resolveOpts(opts);
  const changes: FileChange[] = [];
  const settings = readJson(o.settingsFile);
  const plugin = remove ? null : sievePlugin(o.configDir, settings.value);
  if (plugin)
    throw new Error(
      `the Sieve plugin (${plugin}) already registers Sieve's hooks and MCP server for Claude Code; setup would answer every event twice. Keep the plugin, or remove it first: claude plugin uninstall ${plugin}`,
    );
  const next = remove
    ? stripHooks(settings.value as HookSettings, AGENT)
    : withHooks(
        settings.value as HookSettings,
        AGENT,
        o.shimPath,
        EVENTS.map((event) => ({ event, timeout: 5, ...(TOOL_EVENTS.has(event) ? { matcher: "*" } : {}) })),
      );
  const sc = jsonChange(
    o.settingsFile,
    settings,
    next,
    remove ? ["remove Sieve hook entries"] : EVENTS.map((e) => `hook ${e} → ${hookCommand(o.shimPath, e)}`),
    remove,
  );
  if (sc) changes.push(sc);

  const state = readJson(o.stateFile);
  const servers = { ...((state.value.mcpServers as Record<string, unknown>) ?? {}) };
  if (remove) delete servers[MCP_NAME];
  else
    servers[MCP_NAME] = {
      type: "stdio",
      command: o.sievePath,
      args: [...(o.sieveArgs ?? []), "mcp"],
      env: {},
    };
  const nextState: Record<string, unknown> = { ...state.value, mcpServers: servers };
  if (remove && Object.keys(servers).length === 0) delete nextState.mcpServers;
  const mc = jsonChange(
    o.stateFile,
    state,
    nextState,
    [remove ? `remove MCP server "${MCP_NAME}"` : `MCP server "${MCP_NAME}" → ${o.sievePath} mcp`],
    remove,
  );
  if (mc) changes.push(mc);
  return changes;
}

/** Check that Claude Code's config points at Sieve. Returns problems; empty means healthy. */
export function verifySetup(opts: ClaudeSetupOptions): string[] {
  const o = resolveOpts(opts);
  const problems: string[] = [];
  let settings: HookSettings;
  try {
    settings = readJson(o.settingsFile).value as HookSettings;
  } catch (e) {
    return [`cannot read ${o.settingsFile}: ${(e as Error).message}`];
  }
  const plugin = sievePlugin(o.configDir, settings as Record<string, unknown>);
  if (plugin) {
    const bin = o.pluginBinDir ?? join(sieveHome(), "bin");
    if (!existsSync(join(bin, "sieve-hook")) || !existsSync(join(bin, "sieve")))
      problems.push(`the Sieve plugin is installed but its binaries are not (${bin}): run /sieve:install`);
    if (missingHooks(settings, AGENT, [...EVENTS]).length < EVENTS.length)
      problems.push(
        `Sieve is registered twice: by the plugin (${plugin}) and by setup's hooks in ${o.settingsFile}. Only setup's hooks act; remove them to use the plugin: sieve setup --remove --agents claude-code`,
      );
    return problems;
  }
  for (const ev of missingHooks(settings, AGENT, [...EVENTS])) problems.push(`hook ${ev} is not registered`);
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

export const setupSpec: AgentSetup<ClaudeSetupOptions> = {
  agent: AGENT,
  support: "live",
  detect: (home = homedir()) => existsSync(join(home, ".claude")) || !!Bun.which("claude"),
  plan: planSetup,
  verify: verifySetup,
};

/**
 * Apply setup (or removal). Every touched file is backed up first. If the post-write check
 * fails, every file is restored and the result says so. Running it twice changes nothing.
 */
export const applySetup = (opts: ClaudeSetupOptions, remove = false): SetupResult =>
  kitApply(setupSpec, opts, remove);
