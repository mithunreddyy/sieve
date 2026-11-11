import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AgentSetup,
  type BaseSetupOptions,
  canonical,
  type FileChange,
  jsonChange,
  readJson,
  readJsonc,
} from "@sieve/adapter-kit";

/**
 * Agents that Sieve reaches through MCP only (slice 12): Zed and Kiro. They get Sieve's tools
 * (`sieve_run`, `sieve_search`, `sieve_resume`, …) but no hooks, so nothing is folded automatically
 * and Guard cannot see their own tool calls. The brief's fallback for "no hook system" applies: the
 * agent is told, by an instruction snippet, to call `sieve_resume` first.
 *
 * Sources: Zed's `context_servers` entry (command, args, env) and Kiro's `mcpServers` entry and
 * `~/.kiro/settings/mcp.json` were read from each product's own documentation. Zed's documentation
 * page does not give the settings file's location; `~/.config/zed/settings.json` is the usual one and
 * is NOT confirmed here. Neither agent has been run with Sieve: both are "preview".
 */

export const INSTRUCTION_SNIPPET = `## Sieve
Sieve is connected as an MCP server. At the start of a task, and after any context reset, call \`sieve_resume\`.
Prefer \`sieve_run\` or \`sieve_batch\` for commands with long output, and \`sieve_read\` for large files: they return a short receipt and keep the full text, which \`sieve_get\` expands exactly.
Use \`sieve_search\` before re-running something, and \`sieve_remember\` / \`sieve_recall\` for lasting project facts.`;

export interface McpOnlyOptions extends BaseSetupOptions {
  settingsFile?: string;
}

interface Spec {
  agent: string;
  /** Top-level key that holds the servers. */
  key: string;
  file(home: string): string;
  detect(home: string): boolean;
  entry(o: McpOnlyOptions): Record<string, unknown>;
}

const NAME = "sieve";

const SPECS: Spec[] = [
  {
    agent: "zed",
    key: "context_servers",
    file: (h) => join(h, ".config", "zed", "settings.json"),
    detect: (h) => existsSync(join(h, ".config", "zed")) || existsSync("/Applications/Zed.app"),
    entry: (o) => ({ command: o.sievePath, args: [...(o.sieveArgs ?? []), "mcp"], env: {} }),
  },
  {
    agent: "kiro",
    key: "mcpServers",
    file: (h) => join(h, ".kiro", "settings", "mcp.json"),
    detect: (h) => existsSync(join(h, ".kiro")) || existsSync("/Applications/Kiro.app"),
    entry: (o) => ({ command: o.sievePath, args: [...(o.sieveArgs ?? []), "mcp"], env: {}, disabled: false }),
  },
];

function make(spec: Spec): AgentSetup<McpOnlyOptions> {
  const path = (o: McpOnlyOptions) => o.settingsFile ?? spec.file(o.home ?? homedir());
  return {
    agent: spec.agent,
    support: "preview",
    detect: (home = homedir()) => spec.detect(home),
    after: `Sieve is connected through MCP only: no hooks, so nothing is shortened automatically. Add this to ${spec.agent}'s own rules or instructions yourself (Sieve does not edit them):\n\n${INSTRUCTION_SNIPPET}`,
    plan(o, remove = false): FileChange[] {
      const file = path(o);
      // A file with comments is never rewritten (that would drop them): say so and give the block.
      // If it is already in the wanted state there is nothing to do, so a hand merge converges.
      const loose = readJsonc(file);
      if (!loose.strict) {
        const have = (loose.value[spec.key] as Record<string, unknown> | undefined)?.[NAME];
        if (remove ? have === undefined : have !== undefined && canonical(have) === canonical(spec.entry(o)))
          return [];
        const why = `${file} has comments or trailing commas, so Sieve will not rewrite it (they would be lost).`;
        const block = JSON.stringify({ [spec.key]: { [NAME]: spec.entry(o) } }, null, 2);
        throw new Error(
          remove
            ? `${why} Remove the "${NAME}" entry under "${spec.key}" by hand.`
            : `${why} Merge this into it by hand:\n${block}`,
        );
      }
      const cur = readJson(file); // throws on invalid JSON: nothing is overwritten
      const servers = { ...((cur.value[spec.key] as Record<string, unknown>) ?? {}) };
      if (remove) delete servers[NAME];
      else servers[NAME] = spec.entry(o);
      const next: Record<string, unknown> = { ...cur.value, [spec.key]: servers };
      if (Object.keys(servers).length === 0) delete next[spec.key];
      const c = jsonChange(
        file,
        cur,
        next,
        remove ? [`remove MCP server "${NAME}"`] : [`MCP server "${NAME}" → ${o.sievePath} mcp`],
        remove,
      );
      return c ? [c] : [];
    },
    verify(o) {
      const file = path(o);
      let v: Record<string, unknown>;
      try {
        v = readJsonc(file).value;
      } catch (e) {
        return [`cannot read ${file}: ${(e as Error).message}`];
      }
      const e = (v[spec.key] as Record<string, { command?: string }> | undefined)?.[NAME];
      if (!e) return [`MCP server "${NAME}" is not registered in ${file}`];
      return e.command && !existsSync(e.command) ? [`MCP command not found: ${e.command}`] : [];
    },
  };
}

export const zedSetup = make(SPECS[0]!);
export const kiroSetup = make(SPECS[1]!);
export const mcpOnlySetups: AgentSetup<McpOnlyOptions>[] = [zedSetup, kiroSetup];
