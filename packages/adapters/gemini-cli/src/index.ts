import type { AgentCapabilities, SieveEvent, SieveReply, ToolFamily, ToolRef } from "@sieve/protocol";

/**
 * Gemini CLI adapter. Mapping read from Gemini CLI 0.65.0's bundled hook docs and source
 * (docs/hooks/reference.md, coreToolHookTriggers, hookRunner), not from a live session yet.
 *
 * What Gemini CLI allows, and why Sieve uses only part of it:
 * - AfterTool `decision: "deny"` does not swap the result: the model receives
 *   "Tool result blocked: <reason>" marked as a failed tool call. A receipt sent that way
 *   would look like a failed command, so Sieve never replaces Gemini tool results (replace:
 *   "none"); output is archived and searchable, and the agent can call sieve_run directly.
 * - PreCompress is advisory and fires before Gemini checks whether to compress at all (on
 *   every turn), so only `trigger: "manual"` counts as a context reset (compaction: "manual-only").
 * - BeforeTool `decision: "deny"` sends `reason` to the model as the tool's error: used for
 *   smart reads, as with Claude Code.
 * - additionalContext has `<` and `>` escaped by Gemini; Sieve's text uses neither.
 */
export const AGENT = "gemini-cli";

export const HOOK_EVENTS = {
  SessionStart: "session.start",
  BeforeAgent: "prompt.submit",
  BeforeTool: "tool.before",
  AfterTool: "tool.after",
  PreCompress: "compact.before",
  AfterAgent: "turn.end",
  SessionEnd: "session.end",
} as const;
export type GeminiHookEvent = keyof typeof HOOK_EVENTS;

export const capabilities: AgentCapabilities = {
  replace: "none",
  route: true,
  contextAt: ["session.start", "prompt.submit"],
  deny: true,
  ask: false,
  events: Object.values(HOOK_EVENTS),
  compaction: "manual-only",
  support: "preview",
};

interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: { llmContent?: unknown; returnDisplay?: unknown; error?: unknown } | null;
  mcp_context?: { server_name?: string; tool_name?: string } | null;
  trigger?: string;
  reason?: string;
}

const FAMILY: Record<string, ToolFamily> = {
  run_shell_command: "shell",
  read_file: "read",
  write_file: "edit",
  replace: "edit",
  grep_search: "search",
  glob: "search",
  web_fetch: "web",
  google_web_search: "web",
};

export function toolRef(name: string, mcp?: HookInput["mcp_context"]): ToolRef {
  if (mcp?.server_name) return { name, family: "mcp", server: mcp.server_name };
  if (name.startsWith("mcp_")) return { name, family: "mcp" };
  return { name, family: FAMILY[name] ?? "other" };
}

/** llmContent is a string or an array of parts; the text parts are what the model reads. */
export function outputText(response: HookInput["tool_response"]): { text: string; isError: boolean } {
  if (!response || typeof response !== "object") return { text: "", isError: false };
  const isError = response.error !== undefined && response.error !== null;
  const c = response.llmContent;
  if (typeof c === "string") return { text: c, isError };
  if (Array.isArray(c)) {
    const text = c
      .map((p) =>
        typeof p === "string" ? p : p && typeof p === "object" && typeof p.text === "string" ? p.text : "",
      )
      .filter(Boolean)
      .join("\n");
    return { text, isError };
  }
  return { text: "", isError };
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** read_file: `file_path`, optional `start_line`/`end_line`. A full read has neither. */
export function readRequest(input: unknown): { path: string; full: boolean } | null {
  const i = asRecord(input);
  if (!i || typeof i.file_path !== "string") return null;
  return { path: i.file_path, full: i.start_line === undefined && i.end_line === undefined };
}

/** Gemini truncates large reads and says so in the content; only an untruncated read is whole. */
export function readWasWhole(response: unknown): boolean {
  const { text } = outputText(response as HookInput["tool_response"]);
  return !/^IMPORTANT: The file content has been truncated/m.test(text);
}

export function editedPath(input: unknown): string | null {
  const i = asRecord(input);
  return i && typeof i.file_path === "string" ? i.file_path : null;
}

export const readHints = {
  again: "call read_file again",
  range: (from: number, to: number) => `Call read_file with start_line ${from} and end_line ${to}`,
};

/**
 * ask_user: questions in the input, answers in the result as `{"answers":{"<index>": "..."}}`
 * (llmContent is that JSON). Shape from AskUserInvocation in 0.65.0.
 */
export function answeredQuestions(
  toolName: string,
  input: unknown,
  response: unknown,
): Array<{ header?: string; question: string; answer: string }> {
  if (toolName !== "ask_user") return [];
  const qs = asRecord(input)?.questions;
  if (!Array.isArray(qs)) return [];
  let answers: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(outputText(response as HookInput["tool_response"]).text);
    answers = asRecord(parsed?.answers) ?? {};
  } catch {
    return [];
  }
  const out: Array<{ header?: string; question: string; answer: string }> = [];
  qs.forEach((q, i) => {
    const qr = asRecord(q);
    const a = answers[String(i)];
    const answer = Array.isArray(a) ? a.map(String).join(", ") : typeof a === "string" ? a : "";
    if (!qr || typeof qr.question !== "string" || !answer.trim()) return;
    out.push({
      ...(typeof qr.header === "string" && qr.header.trim() ? { header: qr.header.trim() } : {}),
      question: qr.question,
      answer,
    });
  });
  return out;
}

/** exit_plan_mode succeeds only when the user approves; the plan lives in a file. */
export function approvedPlan(toolName: string, input: unknown, response: unknown): string | null {
  if (toolName !== "exit_plan_mode") return null;
  if (outputText(response as HookInput["tool_response"]).isError) return null;
  const name = asRecord(input)?.plan_filename;
  return typeof name === "string" && name.trim()
    ? `# ${name.trim()}\n(plan file in Gemini CLI's plans directory)`
    : null;
}

/** write_todos: `todos: [{ description, status }]`. */
export function todoList(
  toolName: string,
  input: unknown,
): Array<{ content: string; status: string }> | null {
  if (toolName !== "write_todos") return null;
  const todos = asRecord(input)?.todos;
  if (!Array.isArray(todos)) return null;
  return todos
    .map(asRecord)
    .filter((t): t is Record<string, unknown> => !!t && typeof t.description === "string")
    .map((t) => ({
      content: t.description as string,
      status: typeof t.status === "string" ? t.status : "pending",
    }));
}

export function toEvent(eventName: string, raw: unknown, at: number): SieveEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as HookInput;
  const name = (input.hook_event_name ?? eventName) as GeminiHookEvent;
  const base = {
    agent: AGENT,
    sessionId: input.session_id ?? "unknown",
    context: "main",
    cwd: input.cwd ?? process.cwd(),
    at,
  };
  switch (name) {
    case "SessionStart": {
      const s = input.source;
      return { kind: "session.start", base, source: s === "resume" || s === "clear" ? s : "startup" };
    }
    case "BeforeAgent":
      return { kind: "prompt.submit", base, prompt: input.prompt ?? "" };
    case "BeforeTool":
      return {
        kind: "tool.before",
        base,
        tool: toolRef(input.tool_name ?? "", input.mcp_context),
        input: input.tool_input,
      };
    case "AfterTool":
      return {
        kind: "tool.after",
        base,
        tool: toolRef(input.tool_name ?? "", input.mcp_context),
        input: input.tool_input,
        output: outputText(input.tool_response),
        response: input.tool_response,
      };
    case "PreCompress":
      return { kind: "compact.before", base, trigger: input.trigger === "manual" ? "manual" : "auto" };
    case "AfterAgent":
      return { kind: "turn.end", base };
    case "SessionEnd":
      return { kind: "session.end", base, ...(input.reason ? { reason: input.reason } : {}) };
    default:
      return null;
  }
}

/** Gemini CLI reads one JSON object from stdout; empty stdout means "no opinion". */
export function render(event: SieveEvent, reply: SieveReply, _raw: unknown): string {
  const hookEventName = Object.entries(HOOK_EVENTS).find(([, k]) => k === event.kind)?.[0];
  if (!hookEventName) return "";
  if (event.kind === "tool.before" && reply.decision?.action === "deny")
    return JSON.stringify({ decision: "deny", reason: reply.decision.reason });
  if (reply.context && capabilities.contextAt.includes(event.kind as never))
    return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: reply.context } });
  return "";
}

export * from "./setup.ts";
