import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AgentSetup,
  type BaseSetupOptions,
  type FileChange,
  type HookSettings,
  jsonChange,
  missingHooks,
  readJson,
  stripHooks,
  withHooks,
} from "@sieve/adapter-kit";
import { parse } from "smol-toml";

export interface CodexSetupOptions extends BaseSetupOptions {
  /** Codex config dir (default $CODEX_HOME or ~/.codex): hooks.json and config.toml live here. */
  configDir?: string;
}

const AGENT = "codex";
const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "SubagentStart",
  "Stop",
  "SessionEnd",
];
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);
const MCP_NAME = "sieve";
/** Codex hook timeouts are seconds (default 600; SessionEnd allows at most 3). */
const TIMEOUT_S = 3;
const BEGIN = "# >>> sieve (managed by `sieve setup --agents codex`; do not edit) >>>";
const END = "# <<< sieve <<<";

const dirs = (o: CodexSetupOptions) => {
  const configDir = o.configDir ?? process.env.CODEX_HOME ?? join(o.home ?? homedir(), ".codex");
  return { hooks: join(configDir, "hooks.json"), toml: join(configDir, "config.toml") };
};

const tomlString = (s: string) => JSON.stringify(s); // JSON strings are valid TOML basic strings

/** The managed block: comments and the user's other settings are never rewritten. */
function block(o: CodexSetupOptions): string {
  const args = [...(o.sieveArgs ?? []), "mcp"].map(tomlString).join(", ");
  return `${BEGIN}\n[mcp_servers.${MCP_NAME}]\ncommand = ${tomlString(o.sievePath)}\nargs = [${args}]\n${END}\n`;
}

function withoutBlock(text: string): string {
  const a = text.indexOf(BEGIN);
  if (a === -1) return text;
  const b = text.indexOf(END, a);
  if (b === -1) throw new Error("the Sieve block in config.toml has no end marker; fix or remove it by hand");
  // The block is added after exactly one blank line; take that line out with it.
  let head = text.slice(0, a);
  if (head.endsWith("\n\n")) head = head.slice(0, -1);
  return `${head}${text.slice(b + END.length).replace(/^\n/, "")}`;
}

export function planSetup(o: CodexSetupOptions, remove = false): FileChange[] {
  const d = dirs(o);
  const changes: FileChange[] = [];
  const cur = readJson(d.hooks);
  const next = remove
    ? stripHooks(cur.value as HookSettings, AGENT)
    : withHooks(
        cur.value as HookSettings,
        AGENT,
        o.shimPath,
        EVENTS.map((event) => ({
          event,
          timeout: TIMEOUT_S,
          ...(TOOL_EVENTS.has(event) ? { matcher: "*" } : {}),
        })),
      );
  const hc = jsonChange(
    d.hooks,
    cur,
    next,
    remove ? ["remove Sieve hook entries"] : EVENTS.map((e) => `hook ${e}`),
    remove,
  );
  if (hc) changes.push(hc);

  const before = existsSync(d.toml) ? readFileSync(d.toml, "utf8") : null;
  const rest = withoutBlock(before ?? "");
  if (!remove) {
    // A [mcp_servers.sieve] the user wrote themselves would make a second table: invalid TOML.
    const parsed = rest.trim() ? (parse(rest) as { mcp_servers?: Record<string, unknown> }) : {};
    if (parsed.mcp_servers?.[MCP_NAME])
      throw new Error(
        `${d.toml} already defines [mcp_servers.${MCP_NAME}] outside Sieve's block; remove or rename it first`,
      );
  }
  const after = remove
    ? rest
    : `${rest}${rest && !rest.endsWith("\n") ? "\n" : ""}${rest ? "\n" : ""}${block(o)}`;
  if (before !== after && !(before === null && remove))
    changes.push({
      file: d.toml,
      before,
      after,
      summary: [remove ? `remove MCP server "${MCP_NAME}"` : `MCP server "${MCP_NAME}" → ${o.sievePath} mcp`],
      ...(remove && after.trim() === "" ? { delete: true } : {}),
    });
  return changes;
}

export function verifySetup(o: CodexSetupOptions): string[] {
  const d = dirs(o);
  const problems: string[] = [];
  try {
    const s = readJson(d.hooks).value as HookSettings;
    for (const ev of missingHooks(s, AGENT, EVENTS)) problems.push(`hook ${ev} is not registered`);
  } catch (e) {
    problems.push(`cannot read ${d.hooks}: ${(e as Error).message}`);
  }
  if (!existsSync(o.shimPath)) problems.push(`shim not found at ${o.shimPath}`);
  try {
    const t = parse(existsSync(d.toml) ? readFileSync(d.toml, "utf8") : "") as {
      features?: { hooks?: unknown; codex_hooks?: unknown };
      mcp_servers?: Record<string, { command?: string }>;
    };
    if (t.features?.hooks === false || t.features?.codex_hooks === false)
      problems.push(`hooks are turned off ([features] hooks = false in ${d.toml})`);
    const entry = t.mcp_servers?.[MCP_NAME];
    if (!entry) problems.push(`MCP server "${MCP_NAME}" is not registered`);
    else if (entry.command && !existsSync(entry.command))
      problems.push(`MCP command not found: ${entry.command}`);
  } catch (e) {
    problems.push(`cannot read ${d.toml}: ${(e as Error).message}`);
  }
  return problems;
}

export const setupSpec: AgentSetup<CodexSetupOptions> = {
  agent: AGENT,
  support: "preview",
  detect: (home = homedir()) => existsSync(join(home, ".codex")) || !!Bun.which("codex"),
  plan: planSetup,
  verify: verifySetup,
  after: "Codex runs only hooks you have trusted: start Codex and review them with /hooks.",
};
