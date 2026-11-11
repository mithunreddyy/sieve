import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AgentSetup,
  type BaseSetupOptions,
  type FileChange,
  jsonChange,
  readJson,
} from "@sieve/adapter-kit";
// Bun embeds the plugin's source text (also in the compiled binary). TypeScript does not
// model `type: "text"` imports, hence the directive; a test checks the text is the file.
// @ts-expect-error -- text import
import pluginSource from "../plugin/sieve.ts" with { type: "text" };

export interface OpenCodeSetupOptions extends BaseSetupOptions {
  /** OpenCode config dir (default $XDG_CONFIG_HOME/opencode or ~/.config/opencode) */
  configDir?: string;
}

const AGENT = "opencode";
const MCP_NAME = "sieve";
const MARKER = "// Sieve plugin for OpenCode, written by `sieve setup --agents opencode`.";

function dirs(o: OpenCodeSetupOptions) {
  const configDir =
    o.configDir ??
    (process.env.XDG_CONFIG_HOME && !o.home
      ? join(process.env.XDG_CONFIG_HOME, "opencode")
      : join(o.home ?? homedir(), ".config", "opencode"));
  return {
    configDir,
    plugin: join(configDir, "plugins", "sieve.ts"),
    config: join(configDir, "opencode.json"),
  };
}

/** The plugin as installed: the template with this machine's sieve binary path filled in. */
export function pluginText(sievePath: string): string {
  return (pluginSource as unknown as string).replace('"__SIEVE_BIN__"', JSON.stringify(sievePath));
}

export function planSetup(o: OpenCodeSetupOptions, remove = false): FileChange[] {
  const d = dirs(o);
  const changes: FileChange[] = [];
  const before = existsSync(d.plugin) ? readFileSync(d.plugin, "utf8") : null;
  if (before !== null && !before.startsWith(MARKER))
    throw new Error(`${d.plugin} exists and was not written by Sieve; move it aside first`);
  if (remove) {
    if (before !== null)
      changes.push({
        file: d.plugin,
        before,
        after: "",
        delete: true,
        summary: [`delete the Sieve plugin ${d.plugin}`],
      });
  } else {
    const after = pluginText(o.sievePath);
    if (before !== after) changes.push({ file: d.plugin, before, after, summary: [`plugin ${d.plugin}`] });
  }
  const cur = readJson(d.config);
  const mcp = { ...((cur.value.mcp as Record<string, unknown>) ?? {}) };
  if (remove) delete mcp[MCP_NAME];
  else
    mcp[MCP_NAME] = { type: "local", command: [o.sievePath, ...(o.sieveArgs ?? []), "mcp"], enabled: true };
  const next: Record<string, unknown> = { ...cur.value, mcp };
  if (Object.keys(mcp).length === 0) delete next.mcp;
  if (!remove && cur.text === null) next.$schema = "https://opencode.ai/config.json";
  const c = jsonChange(
    d.config,
    cur,
    next,
    [remove ? `remove MCP server "${MCP_NAME}"` : `MCP server "${MCP_NAME}" → ${o.sievePath} mcp`],
    remove,
  );
  if (c) changes.push(c);
  return changes;
}

export function verifySetup(o: OpenCodeSetupOptions): string[] {
  const d = dirs(o);
  const problems: string[] = [];
  const text = existsSync(d.plugin) ? readFileSync(d.plugin, "utf8") : "";
  if (!text.startsWith(MARKER)) problems.push(`plugin ${d.plugin} is not installed`);
  else if (text !== pluginText(o.sievePath)) problems.push(`plugin ${d.plugin} is out of date`);
  try {
    const entry = (
      readJson(d.config).value.mcp as Record<string, { command?: string[]; enabled?: boolean }>
    )?.[MCP_NAME];
    if (!entry) problems.push(`MCP server "${MCP_NAME}" is not registered`);
    else if (entry.enabled === false) problems.push(`MCP server "${MCP_NAME}" is disabled`);
    else if (entry.command?.[0] && !existsSync(entry.command[0]))
      problems.push(`MCP command not found: ${entry.command[0]}`);
  } catch (e) {
    problems.push(`cannot read ${d.config}: ${(e as Error).message}`);
  }
  return problems;
}

export const setupSpec: AgentSetup<OpenCodeSetupOptions> = {
  agent: AGENT,
  support: "preview",
  detect: (home = homedir()) => existsSync(join(home, ".config", "opencode")) || !!Bun.which("opencode"),
  plan: planSetup,
  verify: verifySetup,
};
