import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AgentSetup,
  type BaseSetupOptions,
  canonical,
  type FileChange,
  isSieveHook,
  jsonChange,
  readJson,
  shellQuote,
} from "@sieve/adapter-kit";

export interface CursorSetupOptions extends BaseSetupOptions {
  /** Cursor config dir (default ~/.cursor). hooks.json and mcp.json live here. */
  configDir?: string;
}

const AGENT = "cursor";
const EVENTS = [
  "sessionStart",
  "beforeSubmitPrompt",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "preCompact",
  "subagentStart",
  "stop",
  "sessionEnd",
];
const MCP_NAME = "sieve";
/** Cursor hook timeouts are seconds (the Claude Code importer passes them through unchanged). */
const TIMEOUT_S = 5;

type Entry = { command?: string; type?: string; matcher?: string; timeout?: number } & Record<
  string,
  unknown
>;
type HooksFile = { version?: number; hooks?: Record<string, Entry[]> } & Record<string, unknown>;

const dirs = (o: CursorSetupOptions) => {
  const configDir = o.configDir ?? join(o.home ?? homedir(), ".cursor");
  return { hooks: join(configDir, "hooks.json"), mcp: join(configDir, "mcp.json") };
};
const cmd = (shim: string, event: string) => `${shellQuote(shim)} ${AGENT} ${event}`;

function strip(f: HooksFile): HooksFile {
  const hooks: Record<string, Entry[]> = {};
  for (const [ev, entries] of Object.entries(f.hooks ?? {})) {
    const kept = (entries ?? []).filter((e) => !isSieveHook(e.command, AGENT));
    if (kept.length) hooks[ev] = kept;
  }
  const out: HooksFile = { ...f, hooks };
  if (!Object.keys(hooks).length) delete out.hooks;
  return out;
}

export function planSetup(o: CursorSetupOptions, remove = false): FileChange[] {
  const d = dirs(o);
  const changes: FileChange[] = [];
  const cur = readJson(d.hooks);
  const base = strip(cur.value as HooksFile);
  let next: HooksFile = base;
  if (!remove) {
    const hooks: Record<string, Entry[]> = { ...(base.hooks ?? {}) };
    for (const ev of EVENTS)
      hooks[ev] = [
        ...(hooks[ev] ?? []),
        { type: "command", command: cmd(o.shimPath, ev), timeout: TIMEOUT_S },
      ];
    next = { version: 1, ...base, hooks };
  }
  // A hooks.json that held only Sieve's entries (and the version we wrote) goes away entirely.
  const empty = remove && canonical(next) === canonical({ version: 1 });
  const hc = jsonChange(
    d.hooks,
    cur,
    next,
    remove ? ["remove Sieve hook entries"] : EVENTS.map((e) => `hook ${e} → ${cmd(o.shimPath, e)}`),
    remove,
  );
  if (hc) changes.push(empty ? { ...hc, delete: true } : hc);

  const mcpCur = readJson(d.mcp);
  const servers = { ...((mcpCur.value.mcpServers as Record<string, unknown>) ?? {}) };
  if (remove) delete servers[MCP_NAME];
  else servers[MCP_NAME] = { command: o.sievePath, args: [...(o.sieveArgs ?? []), "mcp"] };
  const mcpNext: Record<string, unknown> = { ...mcpCur.value, mcpServers: servers };
  const mc = jsonChange(
    d.mcp,
    mcpCur,
    mcpNext,
    [remove ? `remove MCP server "${MCP_NAME}"` : `MCP server "${MCP_NAME}" → ${o.sievePath} mcp`],
    remove,
  );
  if (mc) changes.push(mc);
  return changes;
}

export function verifySetup(o: CursorSetupOptions): string[] {
  const d = dirs(o);
  const problems: string[] = [];
  try {
    const hooks = (readJson(d.hooks).value as HooksFile).hooks ?? {};
    for (const ev of EVENTS)
      if (!(hooks[ev] ?? []).some((e) => isSieveHook(e.command, AGENT)))
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

export const setupSpec: AgentSetup<CursorSetupOptions> = {
  agent: AGENT,
  support: "preview",
  detect: (home = homedir()) => existsSync(join(home, ".cursor")) || !!Bun.which("cursor-agent"),
  plan: planSetup,
  verify: verifySetup,
};
