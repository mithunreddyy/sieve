import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AgentSetup,
  type BaseSetupOptions,
  type FileChange,
  type HookSettings,
  hookCommand,
  jsonChange,
  missingHooks,
  readJson,
  stripHooks,
  withHooks,
} from "@sieve/adapter-kit";

export interface GeminiSetupOptions extends BaseSetupOptions {
  /** User settings file (default ~/.gemini/settings.json). Hooks and MCP servers both live here. */
  settingsFile?: string;
}

const AGENT = "gemini-cli";
const EVENTS = [
  "SessionStart",
  "BeforeAgent",
  "BeforeTool",
  "AfterTool",
  "PreCompress",
  "AfterAgent",
  "SessionEnd",
];
const TOOL_EVENTS = new Set(["BeforeTool", "AfterTool"]);
const MCP_NAME = "sieve";
/** Gemini CLI hook timeouts are milliseconds (default 60 s); the shim gives up far sooner. */
const TIMEOUT_MS = 5000;

const settingsPath = (o: GeminiSetupOptions) =>
  o.settingsFile ?? join(o.home ?? homedir(), ".gemini", "settings.json");

export function planSetup(o: GeminiSetupOptions, remove = false): FileChange[] {
  const file = settingsPath(o);
  const cur = readJson(file);
  let next: Record<string, unknown> = remove
    ? stripHooks(cur.value as HookSettings, AGENT)
    : withHooks(
        cur.value as HookSettings,
        AGENT,
        o.shimPath,
        EVENTS.map((event) => ({
          event,
          name: "sieve",
          timeout: TIMEOUT_MS,
          ...(TOOL_EVENTS.has(event) ? { matcher: ".*" } : {}),
        })),
      );
  const servers = { ...((next.mcpServers as Record<string, unknown>) ?? {}) };
  if (remove) delete servers[MCP_NAME];
  else servers[MCP_NAME] = { command: o.sievePath, args: [...(o.sieveArgs ?? []), "mcp"] };
  next = { ...next, mcpServers: servers };
  if (Object.keys(servers).length === 0) delete next.mcpServers;
  const summary = remove
    ? ["remove Sieve hook entries", `remove MCP server "${MCP_NAME}"`]
    : [
        ...EVENTS.map((e) => `hook ${e} → ${hookCommand(o.shimPath, AGENT, e)}`),
        `MCP server "${MCP_NAME}" → ${o.sievePath} mcp`,
      ];
  const c = jsonChange(file, cur, next, summary, remove);
  return c ? [c] : [];
}

export function verifySetup(o: GeminiSetupOptions): string[] {
  const file = settingsPath(o);
  let s: HookSettings;
  try {
    s = readJson(file).value as HookSettings;
  } catch (e) {
    return [`cannot read ${file}: ${(e as Error).message}`];
  }
  const problems = missingHooks(s, AGENT, EVENTS).map((ev) => `hook ${ev} is not registered`);
  const hooksConfig = s.hooksConfig as { enabled?: unknown } | undefined;
  if (hooksConfig?.enabled === false)
    problems.push(`hooks are turned off (hooksConfig.enabled = false in ${file})`);
  if (!existsSync(o.shimPath)) problems.push(`shim not found at ${o.shimPath}`);
  const entry = (s.mcpServers as Record<string, { command?: string }> | undefined)?.[MCP_NAME];
  if (!entry) problems.push(`MCP server "${MCP_NAME}" is not registered`);
  else if (entry.command && !existsSync(entry.command))
    problems.push(`MCP command not found: ${entry.command}`);
  return problems;
}

export const setupSpec: AgentSetup<GeminiSetupOptions> = {
  agent: AGENT,
  support: "preview",
  detect: (home = homedir()) => existsSync(join(home, ".gemini")) || !!Bun.which("gemini"),
  plan: planSetup,
  verify: verifySetup,
};
