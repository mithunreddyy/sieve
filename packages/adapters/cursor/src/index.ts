import type { AgentCapabilities, SieveEvent, SieveReply, ToolFamily, ToolRef } from "@sieve/protocol";

/**
 * Cursor adapter (Cursor Agent CLI 2026.04.28, hooks read from its bundled hook module:
 * the request payloads, the response validators, and the Claude Code config importer).
 * Not yet exercised by a live session.
 *
 * What Cursor allows, and what Sieve therefore does:
 * - postToolUse can only ADD `additional_context`; there is no field that replaces a result.
 *   So replace: "none". Large output is archived and searchable.
 * - preToolUse returns `permission` (+ `user_message` for the user, `agent_message` for the
 *   model): used for smart reads.
 * - beforeSubmitPrompt returns only `continue`/`user_message`, and preCompact only
 *   `user_message`: neither can add context. Notes for the model (staleness, recall, the state
 *   block after compaction) wait and ride on the next postToolUse (contextAt "tool.after").
 *   sessionStart takes `additional_context`.
 * - Cursor converts Claude Code hook configs and would call `sieve-hook claude-code …` with
 *   its own payload; the Claude Code adapter ignores payloads with no `session_id`.
 */
export const AGENT = "cursor";

export const HOOK_EVENTS = {
  sessionStart: "session.start",
  beforeSubmitPrompt: "prompt.submit",
  preToolUse: "tool.before",
  postToolUse: "tool.after",
  postToolUseFailure: "tool.after",
  preCompact: "compact.before",
  subagentStart: "subagent.start",
  stop: "turn.end",
  sessionEnd: "session.end",
} as const;
export type CursorHookEvent = keyof typeof HOOK_EVENTS;

export const capabilities: AgentCapabilities = {
  replace: "none",
  route: true,
  contextAt: ["session.start", "tool.after"],
  deny: true,
  ask: true,
  events: Object.values(HOOK_EVENTS),
  compaction: "reliable",
  support: "preview",
};

interface HookInput {
  conversation_id?: string;
  session_id?: string;
  generation_id?: string;
  cwd?: string;
  workspace_roots?: string[];
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: unknown;
  error_message?: string;
  prompt?: string;
  trigger?: string;
  subagent_type?: string;
  subagent_id?: string;
  parent_conversation_id?: string;
  reason?: string;
  source?: string;
}

const FAMILY: Record<string, ToolFamily> = {
  Shell: "shell",
  Read: "read",
  Write: "edit",
  Edit: "edit",
  StrReplace: "edit",
  Delete: "edit",
  EditNotebook: "edit",
  Grep: "search",
  Glob: "search",
  SemanticSearch: "search",
  WebFetch: "web",
  WebSearch: "web",
};

/** Cursor names MCP tools `MCP:<tool>` in matchers; the server is not part of the name. */
export function toolRef(name: string): ToolRef {
  if (FAMILY[name]) return { name, family: FAMILY[name] };
  if (name.startsWith("MCP:"))
    return { name, family: "mcp", ...(/sieve_/.test(name) ? { server: "sieve" } : {}) };
  return { name, family: "other" };
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** A tool's output is a string, or JSON text for structured results; the text is what the model reads. */
export function outputText(out: unknown): string {
  if (typeof out === "string") return out;
  if (out === undefined || out === null) return "";
  return JSON.stringify(out);
}

const pathArg = (input: unknown) => {
  const a = asRecord(input);
  const p = a?.path ?? a?.file_path ?? a?.target_file ?? a?.filePath;
  return typeof p === "string" && p ? p : null;
};

export function readRequest(input: unknown): { path: string; full: boolean } | null {
  const p = pathArg(input);
  if (!p) return null;
  const a = asRecord(input)!;
  return { path: p, full: a.offset === undefined && a.limit === undefined };
}

/** Cursor does not say whether a read was whole; without that, a read counts as partial. */
export const readWasWhole = (_response: unknown) => false;

export const editedPath = (input: unknown) => pathArg(input);

export const readHints = {
  again: "read it again",
  range: (from: number, to: number) => `Read with offset ${from} and limit ${to - from + 1}`,
};

/** Cursor's todo tool is `TodoWrite` with `todos: [{content, status}]`. */
export function todoList(
  toolName: string,
  input: unknown,
): Array<{ content: string; status: string }> | null {
  if (toolName !== "TodoWrite") return null;
  const todos = asRecord(input)?.todos;
  if (!Array.isArray(todos)) return null;
  return todos
    .map(asRecord)
    .filter((t): t is Record<string, unknown> => !!t && typeof t.content === "string")
    .map((t) => ({
      content: t.content as string,
      status: typeof t.status === "string" ? t.status : "pending",
    }));
}

export function toEvent(eventName: string, raw: unknown, at: number): SieveEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as HookInput;
  const sessionId = input.conversation_id || input.session_id;
  if (!sessionId) return null;
  // A subagent has its own conversation; its parent is named, but it is its own reader.
  const base = {
    agent: AGENT,
    sessionId,
    context: "main",
    cwd: input.cwd || input.workspace_roots?.[0] || process.cwd(),
    at,
  };
  switch (eventName as CursorHookEvent) {
    case "sessionStart":
      return { kind: "session.start", base, source: input.source === "resume" ? "resume" : "startup" };
    case "beforeSubmitPrompt":
      return { kind: "prompt.submit", base, prompt: input.prompt ?? "" };
    case "preToolUse":
      return { kind: "tool.before", base, tool: toolRef(input.tool_name ?? ""), input: input.tool_input };
    case "postToolUse":
      return {
        kind: "tool.after",
        base,
        tool: toolRef(input.tool_name ?? ""),
        input: input.tool_input,
        output: { text: outputText(input.tool_output), isError: false },
        response: input.tool_output,
      };
    case "postToolUseFailure":
      return {
        kind: "tool.after",
        base,
        tool: toolRef(input.tool_name ?? ""),
        input: input.tool_input,
        output: { text: input.error_message ?? "", isError: true },
        response: null,
      };
    case "preCompact":
      return { kind: "compact.before", base, trigger: input.trigger === "manual" ? "manual" : "auto" };
    case "subagentStart":
      return {
        kind: "subagent.start",
        base,
        ...(input.subagent_type ? { subagentType: input.subagent_type } : {}),
      };
    case "stop":
      return { kind: "turn.end", base };
    case "sessionEnd":
      return { kind: "session.end", base, ...(input.reason ? { reason: input.reason } : {}) };
    default:
      return null;
  }
}

/** Cursor reads one JSON object from stdout; empty stdout means "no opinion". */
export function render(event: SieveEvent, reply: SieveReply, _raw: unknown): string {
  if (event.kind === "tool.before" && reply.decision?.action === "ask")
    return JSON.stringify({
      permission: "ask",
      user_message: reply.decision.reason,
      agent_message: reply.decision.reason,
    });
  if (event.kind === "tool.before" && reply.decision?.action === "deny")
    return JSON.stringify({
      permission: "deny",
      user_message:
        reply.decision.ruleId === "sieve.smart-read"
          ? "Sieve answered this read from what you already have; the agent was told how to get more."
          : reply.decision.reason,
      agent_message: reply.decision.reason,
    });
  if (event.kind === "session.start" && reply.context)
    return JSON.stringify({ additional_context: reply.context });
  if (event.kind === "tool.after" && reply.context)
    return JSON.stringify({ additional_context: reply.context });
  return "";
}

export * from "./setup.ts";
