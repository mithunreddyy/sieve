import type { AgentCapabilities, SieveEvent, SieveReply, ToolFamily, ToolRef } from "@sieve/protocol";

/**
 * GitHub Copilot CLI adapter. Mapping from GitHub's hooks reference
 * (docs.github.com/en/copilot/reference/hooks-configuration, read 2026-11-11). Copilot CLI is
 * not installed on the build machine, so nothing has run against the real thing. Preview.
 *
 * - postToolUse `modifiedResult` is documented as honored by command hooks: a real replace.
 * - userPromptSubmitted output is dropped for command hooks, and preCompact is notification
 *   only: notes for the model wait and ride on the next postToolUse `additionalContext`
 *   (contextAt "tool.after"). sessionStart takes `additionalContext`.
 * - preToolUse is fail-closed in Copilot ("hook errored" denies the call), unlike every other
 *   agent here. Sieve's shim exits 0 with empty output whenever anything goes wrong, so a
 *   Sieve problem still never blocks a tool call; a test covers the empty reply.
 */
export const AGENT = "copilot-cli";

export const HOOK_EVENTS = {
  sessionStart: "session.start",
  userPromptSubmitted: "prompt.submit",
  preToolUse: "tool.before",
  postToolUse: "tool.after",
  postToolUseFailure: "tool.after",
  preCompact: "compact.before",
  subagentStart: "subagent.start",
  agentStop: "turn.end",
  sessionEnd: "session.end",
} as const;
export type CopilotHookEvent = keyof typeof HOOK_EVENTS;

export const capabilities: AgentCapabilities = {
  replace: "all",
  route: true,
  contextAt: ["session.start", "tool.after"],
  deny: true,
  ask: true,
  events: Object.values(HOOK_EVENTS),
  compaction: "reliable",
  support: "preview",
};

interface HookInput {
  sessionId?: string;
  cwd?: string;
  source?: string;
  prompt?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: { resultType?: string; textResultForLlm?: unknown } | null;
  error?: unknown;
  trigger?: string;
  agentId?: string;
  agentName?: string;
  agentType?: string;
  reason?: string;
}

const FAMILY: Record<string, ToolFamily> = {
  bash: "shell",
  powershell: "shell",
  view: "read",
  create: "edit",
  edit: "edit",
  str_replace_editor: "edit",
  apply_patch: "edit",
  grep: "search",
  glob: "search",
  rg: "search",
  web_fetch: "web",
  web_search: "web",
};

/** The docs give no MCP tool-name format; Sieve's own tools are recognised by their names. */
export function toolRef(name: string): ToolRef {
  if (FAMILY[name]) return { name, family: FAMILY[name] };
  if (/sieve_(run|get|search|read|index|batch|stats|resume)$/.test(name))
    return { name, family: "mcp", server: "sieve" };
  return { name, family: "other" };
}

/** toolArgs is typed "unknown" in the docs and shown as a JSON string: accept both. */
export function parseArgs(v: unknown): Record<string, unknown> | null {
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const pathArg = (args: unknown) => {
  const a = parseArgs(args);
  const p = a?.path ?? a?.file_path ?? a?.filePath;
  return typeof p === "string" && p ? p : null;
};

export function readRequest(input: unknown): { path: string; full: boolean } | null {
  const p = pathArg(input);
  if (!p) return null;
  const a = parseArgs(input)!;
  return { path: p, full: a.view_range === undefined && a.offset === undefined && a.limit === undefined };
}
/** Copilot does not report whether a view was whole: counts as partial, so no "unchanged" claim. */
export const readWasWhole = (_response: unknown) => false;
export const editedPath = (input: unknown) => pathArg(input);

export const readHints = {
  again: "view it again",
  range: (from: number, to: number) => `Call view with view_range [${from}, ${to}]`,
};

/** toolArgs as an object when it is (or contains) JSON, else as given. */
const argsOf = (v: unknown): unknown => parseArgs(v) ?? v;

export function toEvent(eventName: string, raw: unknown, at: number): SieveEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as HookInput;
  if (typeof input.sessionId !== "string" || !input.sessionId) return null;
  const base = {
    agent: AGENT,
    sessionId: input.sessionId,
    context: input.agentId ? `sub:${input.agentId}` : "main",
    cwd: input.cwd ?? process.cwd(),
    at,
  };
  switch (eventName as CopilotHookEvent) {
    case "sessionStart":
      return { kind: "session.start", base, source: input.source === "resume" ? "resume" : "startup" };
    case "userPromptSubmitted":
      return { kind: "prompt.submit", base, prompt: input.prompt ?? "" };
    case "preToolUse":
      return {
        kind: "tool.before",
        base,
        tool: toolRef(input.toolName ?? ""),
        input: argsOf(input.toolArgs),
      };
    case "postToolUse": {
      const r = input.toolResult;
      const text = typeof r?.textResultForLlm === "string" ? r.textResultForLlm : "";
      return {
        kind: "tool.after",
        base,
        tool: toolRef(input.toolName ?? ""),
        input: argsOf(input.toolArgs),
        output: { text, isError: r?.resultType !== undefined && r.resultType !== "success" },
        response: r,
      };
    }
    case "postToolUseFailure":
      return {
        kind: "tool.after",
        base,
        tool: toolRef(input.toolName ?? ""),
        input: argsOf(input.toolArgs),
        output: { text: typeof input.error === "string" ? input.error : "", isError: true },
        response: null,
      };
    case "preCompact":
      return { kind: "compact.before", base, trigger: input.trigger === "manual" ? "manual" : "auto" };
    case "subagentStart":
      return { kind: "subagent.start", base, ...(input.agentName ? { subagentType: input.agentName } : {}) };
    case "agentStop":
      return { kind: "turn.end", base };
    case "sessionEnd":
      return { kind: "session.end", base, ...(input.reason ? { reason: input.reason } : {}) };
    default:
      return null;
  }
}

/** One flat JSON object on stdout; empty means "no opinion". */
export function render(event: SieveEvent, reply: SieveReply, _raw: unknown): string {
  if (event.kind === "tool.before" && reply.decision && reply.decision.action !== "allow")
    return JSON.stringify({
      permissionDecision: reply.decision.action,
      permissionDecisionReason: reply.decision.reason,
    });
  if (event.kind === "tool.after") {
    const out: Record<string, unknown> = {};
    if (reply.replaceOutput !== undefined)
      out.modifiedResult = { resultType: "success", textResultForLlm: reply.replaceOutput };
    if (reply.context) out.additionalContext = reply.context;
    return Object.keys(out).length ? JSON.stringify(out) : "";
  }
  if (event.kind === "session.start" && reply.context)
    return JSON.stringify({ additionalContext: reply.context });
  return "";
}

export * from "./setup.ts";
