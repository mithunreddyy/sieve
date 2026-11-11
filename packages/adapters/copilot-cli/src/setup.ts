import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AgentSetup,
  type BaseSetupOptions,
  type FileChange,
  isSieveHook,
  jsonChange,
  readJson,
  shellQuote,
  stringify,
} from "@sieve/adapter-kit";

export interface CopilotSetupOptions extends BaseSetupOptions {
  /** Copilot home (default $COPILOT_HOME or ~/.copilot). */
  copilotHome?: string;
}

const AGENT = "copilot-cli";
const EVENTS = [
  "sessionStart",
  "userPromptSubmitted",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "preCompact",
  "subagentStart",
  "agentStop",
  "sessionEnd",
];
const MCP_NAME = "sieve";
const TIMEOUT_S = 5;
/** Sieve's hooks live in a file of their own: Copilot combines every file in the directory. */
const HOOKS_FILE = "sieve.json";

const dirs = (o: CopilotSetupOptions) => {
  const home = o.copilotHome ?? process.env.COPILOT_HOME ?? join(o.home ?? homedir(), ".copilot");
  return { hooks: join(home, "hooks", HOOKS_FILE), mcp: join(home, "mcp-config.json") };
};
const cmd = (shim: string, event: string) => `${shellQuote(shim)} ${AGENT} ${event}`;

type Entry = { type?: string; bash?: string; command?: string };
const desiredHooks = (shim: string) => ({
  version: 1,
  hooks: Object.fromEntries(
    EVENTS.map((e) => [e, [{ type: "command", bash: cmd(shim, e), cwd: ".", timeoutSec: TIMEOUT_S }]]),
  ),
});

export function planSetup(o: CopilotSetupOptions, remove = false): FileChange[] {
  const d = dirs(o);
  const changes: FileChange[] = [];
  const before = existsSync(d.hooks) ? readFileSync(d.hooks, "utf8") : null;
  if (remove) {
    if (before !== null)
      changes.push({ file: d.hooks, before, after: "", delete: true, summary: [`delete ${d.hooks}`] });
  } else {
    const after = stringify(desiredHooks(o.shimPath));
    if (before !== after)
      changes.push({
        file: d.hooks,
        before,
        after,
        summary: EVENTS.map((e) => `hook ${e} → ${cmd(o.shimPath, e)}`),
      });
  }
  const cur = readJson(d.mcp);
  const servers = { ...((cur.value.mcpServers as Record<string, unknown>) ?? {}) };
  if (remove) delete servers[MCP_NAME];
  else
    servers[MCP_NAME] = {
      type: "local",
      command: o.sievePath,
      args: [...(o.sieveArgs ?? []), "mcp"],
      env: {},
      tools: ["*"],
    };
  const next: Record<string, unknown> = { ...cur.value, mcpServers: servers };
  if (remove && Object.keys(servers).length === 0) delete next.mcpServers;
  const mc = jsonChange(
    d.mcp,
    cur,
    next,
    [remove ? `remove MCP server "${MCP_NAME}"` : `MCP server "${MCP_NAME}" → ${o.sievePath} mcp`],
    remove,
  );
  if (mc) changes.push(mc);
  return changes;
}

export function verifySetup(o: CopilotSetupOptions): string[] {
  const d = dirs(o);
  const problems: string[] = [];
  try {
    const hooks = (readJson(d.hooks).value as { hooks?: Record<string, Entry[]> }).hooks ?? {};
    for (const ev of EVENTS)
      if (!(hooks[ev] ?? []).some((e) => isSieveHook(e.bash ?? e.command, AGENT)))
        problems.push(`hook ${ev} is not registered`);
  } catch (e) {
    problems.push(`cannot read ${d.hooks}: ${(e as Error).message}`);
  }
  if (!existsSync(o.shimPath)) problems.push(`shim not found at ${o.shimPath}`);
  try {
    const entry = (readJson(d.mcp).value.mcpServers as Record<string, { command?: string }> | undefined)?.[
      MCP_NAME
    ];
    if (!entry) problems.push(`MCP server "${MCP_NAME}" is not registered`);
    else if (entry.command && !existsSync(entry.command))
      problems.push(`MCP command not found: ${entry.command}`);
  } catch (e) {
    problems.push(`cannot read ${d.mcp}: ${(e as Error).message}`);
  }
  return problems;
}

export const setupSpec: AgentSetup<CopilotSetupOptions> = {
  agent: AGENT,
  support: "preview",
  // ~/.copilot also exists when only VS Code's Copilot runtime has run, so the binary decides.
  detect: (home = homedir()) => !!Bun.which("copilot") || existsSync(join(home, ".copilot", "hooks")),
  plan: planSetup,
  verify: verifySetup,
  after:
    "Copilot CLI loads hooks when it starts: restart any running session. On Windows the hooks need a powershell entry (not written yet).",
};
