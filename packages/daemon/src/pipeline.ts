import * as claudeCode from "@sieve/adapter-claude-code";
import { countTokens, decideFold, THRESHOLDS } from "@sieve/core";
import type { AgentCapabilities, HookResult, SieveEvent, SieveReply } from "@sieve/protocol";
import type { DaemonContext } from "./context.ts";

export interface Adapter {
  capabilities: AgentCapabilities;
  toEvent(eventName: string, raw: unknown, at: number): SieveEvent | null;
  render(event: SieveEvent, reply: SieveReply, raw: unknown): string;
}

export const ADAPTERS: Record<string, Adapter> = {
  [claudeCode.AGENT]: claudeCode,
};

const PASS: HookResult = { stdout: "", exitCode: 0 };

function sourceOf(ev: Extract<SieveEvent, { kind: "tool.after" }>): string {
  const input = (ev.input ?? {}) as Record<string, unknown>;
  const pick = input.command ?? input.file_path ?? input.url ?? input.pattern ?? input.query;
  const detail = typeof pick === "string" ? pick.replace(/\s+/g, " ").slice(0, 200) : "";
  return detail ? `${ev.tool.name}: ${detail}` : ev.tool.name;
}

/** May the agent's result for this tool be replaced with a receipt? */
function canReplace(caps: AgentCapabilities, ev: Extract<SieveEvent, { kind: "tool.after" }>): boolean {
  if (caps.replace === "none") return false;
  if (caps.replace === "mcp-only" && ev.tool.family !== "mcp") return false;
  // Sieve's own tools already return receipts or exact expansions; never fold them again.
  if (ev.tool.server === "sieve") return false;
  // File reads and edits get outline-based smart reads in slice 3; until then pass them whole.
  if (ev.tool.family === "read" || ev.tool.family === "edit") return false;
  return true;
}

export function handleHook(ctx: DaemonContext, agent: string, eventName: string, raw: unknown): HookResult {
  const adapter = ADAPTERS[agent];
  if (!adapter) return PASS;
  const t0 = performance.now();
  const at = Date.now();
  const ev = adapter.toEvent(eventName, raw, at);
  if (!ev) return PASS;
  const { ref, store } = ctx.project(ev.base.cwd);
  store.touchSession(ev.base.sessionId, agent, ref.worktree, at);

  const reply: SieveReply = {};
  if (ev.kind === "session.end") store.endSession(ev.base.sessionId, at);
  if (ev.kind === "tool.after" && ev.output.text.length >= THRESHOLDS.passBelow) {
    const item = store.put(ev.output.text, {
      sessionId: ev.base.sessionId,
      worktree: ref.worktree,
      agent,
      sourceKind: "tool",
      source: sourceOf(ev),
      at,
    });
    if (item.isNew) ctx.indexLater(store, item.id);
    if (canReplace(adapter.capabilities, ev)) {
      const input = (ev.input ?? {}) as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
      const intent = str(input.description) ?? str(input.prompt);
      const command = str(input.command);
      const pattern = str(input.pattern);
      const d = decideFold(
        {
          text: ev.output.text,
          isError: ev.output.isError,
          toolName: ev.tool.name,
          ...(intent ? { intent } : {}),
          ...(command ? { command } : {}),
          ...(pattern ? { pattern } : {}),
        },
        item,
      );
      if (d.kind === "replace") {
        reply.replaceOutput = d.text;
        ctx.counters.folds++;
        ctx.counters.tokensIn += item.tokens;
        ctx.counters.tokensOut += countTokens(d.text);
      }
    }
  }
  const stdout = adapter.render(ev, reply, raw);
  ctx.health.record(agent, eventName || ev.kind, at, performance.now() - t0);
  return { stdout, exitCode: 0 };
}
