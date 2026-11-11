import type { AgentCapabilities, SieveEvent, SieveReply, ToolFamily, ToolRef } from "@sieve/protocol";

/**
 * Codex CLI adapter. Mapping from OpenAI's hooks documentation (developers.openai.com/codex/hooks,
 * read 2026-11-11); Codex is not installed on the build machine, so nothing here has run against
 * the real thing. Preview.
 *
 * - PostToolUse cannot replace a result with a field. `decision: "block"` "replaces the tool
 *   result with that feedback", but how the model sees that (as a failed call or not) is not
 *   documented, so Sieve does not use it: replace "none", as for Gemini CLI (ADR 0008).
 * - Codex has no file-read tool (files are read through Bash), so there are no smart reads.
 * - SessionStart (source "compact") runs after compaction and takes additionalContext: the
 *   state block goes there. UserPromptSubmit takes additionalContext too.
 * - Non-managed hooks must be trusted in Codex (`/hooks`) before they run: setup cannot do that
 *   for the user.
 */
export const AGENT = "codex";

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
export type CodexHookEvent = keyof typeof HOOK_EVENTS;

export const capabilities: AgentCapabilities = {
  replace: "none",
  route: true,
  contextAt: ["session.start", "prompt.submit"],
  deny: true,
  ask: false,
  events: Object.values(HOOK_EVENTS),
  compaction: "reliable",
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
  tool_response?: unknown;
  trigger?: string;
  agent_id?: string;
  agent_type?: string;
  reason?: string;
}

const FAMILY: Record<string, ToolFamily> = { Bash: "shell", apply_patch: "edit" };

/** MCP tools are `mcp__<server>__<tool>`. */
export function toolRef(name: string): ToolRef {
  if (name.startsWith("mcp__")) {
    const server = name.split("__")[1];
    return { name, family: "mcp", ...(server ? { server } : {}) };
  }
  return { name, family: FAMILY[name] ?? "other" };
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * The text the model reads from a tool_response. The docs say "tool-specific output" and that
 * MCP tools send the MCP call result; the Bash shape is not documented, so this accepts a
 * string, MCP content blocks, or an object with stdout/stderr/output, and falls back to JSON.
 */
export function outputText(response: unknown): { text: string; isError: boolean } {
  if (response === undefined || response === null) return { text: "", isError: false };
  if (typeof response === "string") return { text: response, isError: false };
  if (Array.isArray(response)) return { text: blocks(response), isError: false };
  const r = asRecord(response);
  if (!r) return { text: String(response), isError: false };
  const isError = r.isError === true || r.is_error === true;
  if (Array.isArray(r.content)) return { text: blocks(r.content), isError };
  if (typeof r.stdout === "string" || typeof r.stderr === "string") {
    const out = typeof r.stdout === "string" ? r.stdout : "";
    const err = typeof r.stderr === "string" ? r.stderr : "";
    return {
      text: err ? (out ? `${out}\n${err}` : err) : out,
      isError: isError || (typeof r.exit_code === "number" && r.exit_code !== 0),
    };
  }
  if (typeof r.output === "string") return { text: r.output, isError };
  return { text: JSON.stringify(response), isError };
}
function blocks(b: unknown[]): string {
  return b
    .map((x) =>
      typeof x === "string" ? x : asRecord(x)?.type === "text" ? String(asRecord(x)?.text ?? "") : "",
    )
    .filter(Boolean)
    .join("\n");
}

/** Files named by an apply_patch body (`*** Add File: p`, `*** Update File: p`, `*** Delete File: p`). */
export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1]!.trim());
  return out;
}

/** The first file an edit touched (a log row lists them all through patchPaths when it can). */
export function editedPath(input: unknown): string | null {
  const cmd = asRecord(input)?.command;
  return typeof cmd === "string" ? (patchPaths(cmd)[0] ?? null) : null;
}

export function toEvent(eventName: string, raw: unknown, at: number): SieveEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as HookInput;
  if (typeof input.session_id !== "string" || !input.session_id) return null;
  const name = (input.hook_event_name ?? eventName) as CodexHookEvent;
  const base = {
    agent: AGENT,
    sessionId: input.session_id,
    context: input.agent_id ? `sub:${input.agent_id}` : "main",
    cwd: input.cwd ?? process.cwd(),
    at,
  };
  switch (name) {
    case "SessionStart": {
      const s = input.source;
      return {
        kind: "session.start",
        base,
        source: s === "resume" || s === "clear" || s === "compact" ? s : "startup",
      };
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
        response: input.tool_response,
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

/** Codex reads JSON from stdout; for Stop/SubagentStop plain text is invalid, so those get nothing. */
export function render(event: SieveEvent, reply: SieveReply, _raw: unknown): string {
  const hookEventName = Object.entries(HOOK_EVENTS).find(([, k]) => k === event.kind)?.[0];
  if (!hookEventName) return "";
  if (event.kind === "tool.before" && reply.decision?.action === "deny")
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName,
        permissionDecision: "deny",
        permissionDecisionReason: reply.decision.reason,
      },
    });
  if (reply.context && capabilities.contextAt.includes(event.kind as never))
    return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: reply.context } });
  return "";
}

export * from "./setup.ts";
