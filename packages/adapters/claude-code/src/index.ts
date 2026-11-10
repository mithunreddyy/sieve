import type { AgentCapabilities, SieveEvent, SieveReply, ToolFamily, ToolRef } from "@sieve/protocol";

export const AGENT = "claude-code";

/** Hook events Sieve registers in Claude Code, with the shared event each maps to. */
export const HOOK_EVENTS = {
  SessionStart: "session.start",
  UserPromptSubmit: "prompt.submit",
  PreToolUse: "tool.before",
  PostToolUse: "tool.after",
  PreCompact: "compact.before",
  SubagentStart: "subagent.start",
  Stop: "turn.end",
  SessionEnd: "session.end",
} as const;
export type ClaudeHookEvent = keyof typeof HOOK_EVENTS;

export const capabilities: AgentCapabilities = {
  replace: "all",
  route: true,
  contextAt: ["session.start", "prompt.submit", "subagent.start"],
  deny: true,
  ask: true,
  events: Object.values(HOOK_EVENTS),
};

interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  trigger?: string;
  agent_type?: string;
  reason?: string;
}

const FAMILY: Record<string, ToolFamily> = {
  Bash: "shell",
  BashOutput: "shell",
  Read: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Grep: "search",
  Glob: "search",
  WebFetch: "web",
  WebSearch: "web",
};

export function toolRef(name: string): ToolRef {
  if (name.startsWith("mcp__")) {
    const server = name.split("__")[1];
    return { name, family: "mcp", ...(server ? { server } : {}) };
  }
  return { name, family: FAMILY[name] ?? "other" };
}

/** Flatten a tool_response into the text the model would read, plus an error flag. */
export function outputText(response: unknown): { text: string; isError: boolean } {
  if (response == null) return { text: "", isError: false };
  if (typeof response === "string") return { text: response, isError: false };
  if (Array.isArray(response)) return { text: blocksText(response), isError: false };
  if (typeof response === "object") {
    const r = response as Record<string, unknown>;
    const isError = r.is_error === true || r.isError === true || r.interrupted === true;
    if (typeof r.stdout === "string" || typeof r.stderr === "string") {
      const out = (r.stdout as string | undefined) ?? "";
      const err = (r.stderr as string | undefined) ?? "";
      return { text: err ? (out ? `${out}\n${err}` : err) : out, isError };
    }
    if (Array.isArray(r.content)) return { text: blocksText(r.content), isError };
    // Grep: {mode, filenames, content?}. The model sees content in content mode, else the file list.
    if (typeof r.mode === "string" && Array.isArray(r.filenames)) {
      return {
        text: r.mode === "content" && typeof r.content === "string" ? r.content : r.filenames.join("\n"),
        isError,
      };
    }
    if (typeof r.content === "string") return { text: r.content, isError };
    if (
      r.file &&
      typeof r.file === "object" &&
      typeof (r.file as { content?: unknown }).content === "string"
    ) {
      return { text: (r.file as { content: string }).content, isError };
    }
    return { text: JSON.stringify(response, null, 2), isError };
  }
  return { text: String(response), isError: false };
}

function blocksText(blocks: unknown[]): string {
  return blocks
    .map((b) =>
      b && typeof b === "object" && (b as { type?: string }).type === "text"
        ? String((b as { text?: unknown }).text ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

/**
 * Build a replacement in the same shape as the original tool_response, so Claude Code
 * renders it like the real result. Returns undefined when the shape is not one we know
 * how to rewrite safely; the original then passes through (it is still archived).
 */
export function replacementFor(response: unknown, text: string): unknown | undefined {
  if (typeof response === "string" || response == null) return text;
  if (Array.isArray(response)) return [{ type: "text", text }];
  if (typeof response === "object") {
    const r = response as Record<string, unknown>;
    if ("stdout" in r || "stderr" in r) return { ...r, stdout: text, stderr: "" };
    if (Array.isArray(r.content)) return { ...r, content: [{ type: "text", text }] };
    if (typeof r.mode === "string" && Array.isArray(r.filenames))
      return r.mode === "content" ? { ...r, content: text } : undefined;
    if (typeof r.content === "string") return { ...r, content: text };
  }
  // An unknown shape: replacing it with a bare string could break how the agent renders it.
  return undefined;
}

export function toEvent(eventName: string, raw: unknown, at: number): SieveEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as HookInput;
  const name = (input.hook_event_name ?? eventName) as ClaudeHookEvent;
  const base = {
    agent: AGENT,
    sessionId: input.session_id ?? "unknown",
    cwd: input.cwd ?? process.cwd(),
    at,
  };
  switch (name) {
    case "SessionStart": {
      const s = input.source;
      const source = s === "resume" || s === "clear" || s === "compact" ? s : "startup";
      return { kind: "session.start", base, source };
    }
    case "UserPromptSubmit":
      return { kind: "prompt.submit", base, prompt: input.prompt ?? "" };
    case "PreToolUse":
      return { kind: "tool.before", base, tool: toolRef(input.tool_name ?? ""), input: input.tool_input };
    case "PostToolUse":
      return {
        kind: "tool.after",
        base,
        tool: toolRef(input.tool_name ?? ""),
        input: input.tool_input,
        output: outputText(input.tool_response),
      };
    case "PreCompact":
      return { kind: "compact.before", base, trigger: input.trigger === "manual" ? "manual" : "auto" };
    case "SubagentStart":
      return {
        kind: "subagent.start",
        base,
        ...(input.agent_type ? { subagentType: input.agent_type } : {}),
      };
    case "Stop":
      return { kind: "turn.end", base };
    case "SessionEnd":
      return { kind: "session.end", base, ...(input.reason ? { reason: input.reason } : {}) };
    default:
      return null;
  }
}

/** Turn a pipeline reply into the JSON Claude Code reads from the hook's stdout. */
export function render(event: SieveEvent, reply: SieveReply, raw: unknown): string {
  const hookEventName = Object.entries(HOOK_EVENTS).find(([, k]) => k === event.kind)?.[0];
  if (!hookEventName) return "";
  const out: Record<string, unknown> = { hookEventName };
  if (reply.context && capabilities.contextAt.includes(event.kind as never))
    out.additionalContext = reply.context;
  if (event.kind === "tool.after" && reply.replaceOutput !== undefined) {
    const replaced = replacementFor((raw as HookInput).tool_response, reply.replaceOutput);
    if (replaced !== undefined) out.updatedToolOutput = replaced;
  }
  if (event.kind === "tool.before" && reply.decision) {
    out.permissionDecision = reply.decision.action;
    out.permissionDecisionReason = reply.decision.reason;
  }
  if (Object.keys(out).length === 1) return "";
  return JSON.stringify({ hookSpecificOutput: out });
}

export * from "./setup.ts";
