import type { ProjectRef } from "@sieve/core";
import type { GuardEvent, GuardResult } from "@sieve/guard";
import type { AgentCapabilities, SieveEvent, SieveReply } from "@sieve/protocol";
import type { DaemonContext } from "./context.ts";

/**
 * Guard on the daemon's paths (slice 7): every agent's `tool.before`, and the MCP side of
 * Sieve's own tools. A failure inside Guard never blocks the agent: it is counted and the call
 * goes through (invariant 1). A *decision* to deny is policy, not a failure.
 */

type ToolBefore = Extract<SieveEvent, { kind: "tool.before" }>;

/** The tool part of an MCP tool name: `mcp__server__tool` → `tool`. */
function mcpTool(name: string, server?: string): string {
  if (server && name.startsWith(`mcp__${server}__`)) return name.slice(`mcp__${server}__`.length);
  // Split, not a regex on the server: plugin servers (`plugin_<plugin>_<server>`) contain `_`.
  return name.startsWith("mcp__") ? name.split("__").slice(2).join("__") || name : name;
}

export function guardEventFor(ev: ToolBefore, ref: ProjectRef): GuardEvent {
  return {
    tool: ev.tool.name,
    family: ev.tool.family,
    input: ev.input,
    ...(ev.tool.family === "mcp"
      ? {
          mcp: {
            ...(ev.tool.server ? { server: ev.tool.server } : {}),
            tool: mcpTool(ev.tool.name, ev.tool.server),
          },
        }
      : {}),
    cwd: ev.base.cwd,
    sessionId: ev.base.sessionId,
    worktree: ref.worktree,
    repoRoot: ref.root,
    agent: ev.base.agent,
  };
}

const HOW_TO_ALLOW =
  "To allow it, add an allow rule to ~/.sieve/guard.toml (see `sieve guard check`), or run the command yourself.";

/** Turn a Guard result into a reply for an agent, or null to let the call through. */
export function toDecision(
  r: GuardResult,
  caps: Pick<AgentCapabilities, "ask">,
): SieveReply["decision"] | null {
  if (r.action === "deny")
    return {
      action: "deny",
      reason: r.message!,
      ...(r.decision.ruleId ? { ruleId: r.decision.ruleId } : {}),
    };
  if (r.action !== "ask") return null;
  const id = r.decision.ruleId;
  // Where the agent can show its own permission prompt, use it; otherwise the call is refused and
  // the agent is told why and how to get it allowed.
  return caps.ask
    ? { action: "ask", reason: r.message!, ...(id ? { ruleId: id } : {}) }
    : {
        action: "deny",
        reason: `${r.message} This agent cannot show an approval prompt, so the call was not run. ${HOW_TO_ALLOW}`,
        ...(id ? { ruleId: id } : {}),
      };
}

/** Guard for a hooked agent's tool call. Sieve's own tools are checked on the MCP side instead. */
export function guardBefore(
  ctx: DaemonContext,
  caps: Pick<AgentCapabilities, "ask">,
  ev: ToolBefore,
  ref: ProjectRef,
): SieveReply["decision"] | null {
  if (!ctx.config.guard.enabled || ev.tool.server === "sieve") return null;
  try {
    const r = ctx.guard.evaluate(guardEventFor(ev, ref));
    if (r.decision.action === "deny" || r.decision.action === "ask")
      ctx.counters[r.action === "allow" ? "guardWouldBlock" : "guardBlocked"]++;
    return toDecision(r, caps);
  } catch {
    ctx.counters.sessionErrors++;
    return null;
  }
}

/**
 * Guard for a call to one of Sieve's own tools over MCP. There is no agent prompt to borrow, so
 * "ask" refuses with an explanation. Returns the message to refuse with, or null.
 */
export function guardMcp(ctx: DaemonContext, event: GuardEvent): string | null {
  if (!ctx.config.guard.enabled) return null;
  try {
    const r = ctx.guard.evaluate(event);
    if (r.decision.action === "deny" || r.decision.action === "ask")
      ctx.counters[r.action === "allow" ? "guardWouldBlock" : "guardBlocked"]++;
    if (r.action === "deny") return r.message!;
    if (r.action === "ask")
      return `${r.message} Sieve's tools cannot show an approval prompt, so this was not run. ${HOW_TO_ALLOW}`;
    return null;
  } catch {
    ctx.counters.sessionErrors++;
    return null;
  }
}
