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
  contextAt: Array<"session.start" | "prompt.submit" | "compact.before" | "subagent.start">;
  deny: boolean;
  ask: boolean;
  events: EventKind[];
}
