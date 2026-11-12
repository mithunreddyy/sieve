export type AgentId = "claude-code" | (string & {});

export type ToolFamily = "shell" | "read" | "edit" | "search" | "web" | "mcp" | "other";

export interface EventBase {
  agent: AgentId;
  sessionId: string;
  /** "main", or a subagent's id: each has its own context window (reads are tracked per context). */
  context: string;
  cwd: string;
  /** ms since epoch, set by the daemon on receipt */
  at: number;
  /** The agent's own transcript of this session, when the agent says where it is (Claude Code does). */
  transcriptPath?: string;
}

export interface ToolRef {
  name: string;
  family: ToolFamily;
  /** MCP server name for MCP tools */
  server?: string;
}

export interface ToolOutput {
  text: string;
  isError: boolean;
  /**
   * The agent kept this result in a file because it was large (Claude Code: `persistedOutputPath`),
   * and shows the model only a 2 KB preview of whatever Sieve returns. `text` may then be just a
   * prefix: Claude Code cuts Bash output near 30,000 characters before hooks run.
   * `dir` is the one folder `file` must be inside; `complete` is set by the daemon once `text`
   * has been replaced by the whole result read from `file`.
   */
  persisted?: { totalBytes: number; file?: string; dir?: string; complete?: boolean };
}

export type SieveEvent =
  | { kind: "session.start"; base: EventBase; source: "startup" | "resume" | "clear" | "compact" }
  | { kind: "prompt.submit"; base: EventBase; prompt: string }
  | { kind: "tool.before"; base: EventBase; tool: ToolRef; input: unknown }
  | {
      kind: "tool.after";
      base: EventBase;
      tool: ToolRef;
      input: unknown;
      output: ToolOutput;
      /** The agent's own result object, for adapter-specific checks (e.g. was a read whole?). */
      response?: unknown;
    }
  | { kind: "compact.before"; base: EventBase; trigger: "auto" | "manual" }
  | { kind: "subagent.start"; base: EventBase; subagentType?: string }
  | { kind: "turn.end"; base: EventBase }
  | { kind: "session.end"; base: EventBase; reason?: string };

export type EventKind = SieveEvent["kind"];

export const EVENT_KINDS: readonly EventKind[] = [
  "session.start",
  "prompt.submit",
  "tool.before",
  "tool.after",
  "compact.before",
  "subagent.start",
  "turn.end",
  "session.end",
];

export interface SieveReply {
  context?: string;
  replaceOutput?: string;
  decision?: { action: "allow" | "deny" | "ask"; reason: string; ruleId?: string };
}

export interface AgentCapabilities {
  replace: "all" | "mcp-only" | "none";
  route: boolean;
  /**
   * Where the agent lets Sieve add context. "tool.after" is the fallback for agents with no
   * slot on prompts or compaction: notes for the model wait and ride on the next tool result.
   */
  contextAt: Array<"session.start" | "prompt.submit" | "compact.before" | "subagent.start" | "tool.after">;
  deny: boolean;
  ask: boolean;
  events: EventKind[];
  /**
   * Can Sieve tell when the context window was reset? "reliable": compaction is signalled
   * every time it happens. "manual-only": only a user-triggered compaction is signalled
   * reliably (an automatic signal may fire without compacting), so Sieve never claims the
   * agent still has earlier content ("unchanged since your read") for that agent.
   */
  compaction: "reliable" | "manual-only";
  /** Sends session.start with source "compact" after every real compaction (so a lone compact.before was canceled). */
  compactStart?: boolean;
  /**
   * "verified": a recorded real-agent run passed (docs/e2e). "live": used in real sessions by a
   * developer, but no recorded run. "preview": neither; the mapping comes from docs or source.
   */
  support: "verified" | "live" | "preview";
}
