import * as claudeCode from "@sieve/adapter-claude-code";
import {
  cleanPrompt,
  commandKey,
  compareRuns,
  countTokens,
  decideFold,
  intentTerms,
  type ProjectRef,
  type ProjectStore,
  type ReaderRef,
  THRESHOLDS,
} from "@sieve/core";
import type { AgentCapabilities, HookResult, SieveEvent, SieveReply } from "@sieve/protocol";
import type { DaemonContext } from "./context.ts";
import { type Hints, recordRead, smartReadBefore, staleNotice } from "./reads.ts";

export interface Adapter {
  capabilities: AgentCapabilities;
  toEvent(eventName: string, raw: unknown, at: number): SieveEvent | null;
  render(event: SieveEvent, reply: SieveReply, raw: unknown): string;
  /** Optional read support: agents with a file-read tool. */
  readRequest?(input: unknown): { path: string; full: boolean } | null;
  readWasWhole?(response: unknown): boolean;
  editedPath?(input: unknown): string | null;
  readHints?: Hints;
}

export const ADAPTERS: Record<string, Adapter> = {
  [claudeCode.AGENT]: claudeCode,
};

const PASS: HookResult = { stdout: "", exitCode: 0 };
type ToolAfter = Extract<SieveEvent, { kind: "tool.after" }>;

function sourceOf(ev: ToolAfter): string {
  const input = (ev.input ?? {}) as Record<string, unknown>;
  const pick = input.command ?? input.file_path ?? input.url ?? input.pattern ?? input.query;
  const detail = typeof pick === "string" ? pick.replace(/\s+/g, " ").slice(0, 200) : "";
  return detail ? `${ev.tool.name}: ${detail}` : ev.tool.name;
}

/** May the agent's result for this tool be replaced with a receipt? */
function canReplace(caps: AgentCapabilities, ev: ToolAfter): boolean {
  if (caps.replace === "none") return false;
  if (caps.replace === "mcp-only" && ev.tool.family !== "mcp") return false;
  // Sieve's own tools already return receipts or exact expansions; never fold them again.
  if (ev.tool.server === "sieve") return false;
  // File reads are handled before they run (smart reads); edits must reach the agent as they are.
  if (ev.tool.family === "read" || ev.tool.family === "edit") return false;
  return true;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export function handleHook(ctx: DaemonContext, agent: string, eventName: string, raw: unknown): HookResult {
  const adapter = ADAPTERS[agent];
  if (!adapter) return PASS;
  const t0 = performance.now();
  const at = Date.now();
  const ev = adapter.toEvent(eventName, raw, at);
  if (!ev) return PASS;
  const { ref, store } = ctx.project(ev.base.cwd);
  store.touchSession(ev.base.sessionId, agent, ref.worktree, at);
  const reader: ReaderRef = { sessionId: ev.base.sessionId, context: ev.base.context };

  const reply: SieveReply = {};
  switch (ev.kind) {
    case "session.start":
      // After compaction or /clear, nothing read before is in the context window any more.
      if (ev.source === "compact" || ev.source === "clear") newEpoch(ctx, store, reader);
      break;
    case "compact.before":
      newEpoch(ctx, store, reader);
      break;
    case "session.end":
      store.endSession(ev.base.sessionId, at);
      break;
    case "prompt.submit": {
      const clean = cleanPrompt(ev.prompt);
      // Keep the last prompt that had content: "continue" or a tag-only prompt must not erase it.
      if (intentTerms(clean).length) ctx.lastPrompt.set(ev.base.sessionId, clean.slice(0, 2000));
      const note = staleNotice(ctx, store, ref, reader);
      if (note) reply.context = note;
      break;
    }
    case "tool.before": {
      const req = ev.tool.family === "read" ? adapter.readRequest?.(ev.input) : null;
      if (req?.full && adapter.readHints && adapter.capabilities.deny) {
        const msg = smartReadBefore(ctx, store, ref, reader, req.path, ev.base.cwd, adapter.readHints);
        if (msg) {
          reply.decision = { action: "deny", reason: msg, ruleId: "sieve.smart-read" };
          ctx.counters.readsDeclined++;
        }
      }
      break;
    }
    case "tool.after":
      afterTool(ctx, adapter, store, ref, reader, agent, ev, reply, at);
      break;
  }
  const stdout = adapter.render(ev, reply, raw);
  ctx.health.record(agent, eventName || ev.kind, at, performance.now() - t0);
  return { stdout, exitCode: 0 };
}

function newEpoch(ctx: DaemonContext, store: ProjectStore, reader: ReaderRef): void {
  store.bumpEpoch(reader.sessionId);
  for (const k of ctx.notified.keys()) if (k.startsWith(`${reader.sessionId}|`)) ctx.notified.delete(k);
}

function afterTool(
  ctx: DaemonContext,
  adapter: Adapter,
  store: ProjectStore,
  ref: ProjectRef,
  reader: ReaderRef,
  agent: string,
  ev: ToolAfter,
  reply: SieveReply,
  at: number,
): void {
  // What the agent now knows about files: reads and its own edits.
  if (ev.tool.family === "read" && !ev.output.isError) {
    const req = adapter.readRequest?.(ev.input);
    if (req)
      recordRead(
        ctx,
        store,
        ref,
        reader,
        req.path,
        ev.base.cwd,
        adapter.readWasWhole?.(ev.response) ? "full" : "partial",
        agent,
      );
  }
  if (ev.tool.family === "edit" && !ev.output.isError) {
    const p = adapter.editedPath?.(ev.input);
    if (p) recordRead(ctx, store, ref, reader, p, ev.base.cwd, "edit", agent);
  }
  if (ev.output.text.length < THRESHOLDS.passBelow) return;

  const item = store.put(ev.output.text, {
    sessionId: reader.sessionId,
    worktree: ref.worktree,
    agent,
    sourceKind: "tool",
    source: sourceOf(ev),
    at,
  });
  if (item.isNew) ctx.indexLater(store, item.id);
  const input = (ev.input ?? {}) as Record<string, unknown>;
  const intent = str(input.description) ?? str(input.prompt);
  const command = ev.tool.family === "shell" ? str(input.command) : undefined;
  const pattern = str(input.pattern);
  const replaceable = canReplace(adapter.capabilities, ev);

  // Reruns: compare with the previous run of the same command by this reader in this epoch.
  let preface: string | undefined;
  if (command && ctx.config.reruns.diff) {
    const key = commandKey(command);
    const prev = store.lastRun(reader, ref.worktree, key);
    store.recordRun(reader, ref.worktree, key, item.id, at);
    const prevText = prev ? store.get(prev.archiveId)?.text : undefined;
    const prevInfo = prev ? store.info(prev.archiveId) : null;
    if (prev && prevText !== undefined && prevInfo && replaceable) {
      const r = compareRuns(
        { runNo: prev.runNo, item: { ...prevInfo, isNew: false }, text: prevText },
        item,
        ev.output.text,
        { command, isError: ev.output.isError, toolName: ev.tool.name, ...(intent ? { intent } : {}) },
      );
      if (r.kind === "identical" || r.kind === "diff") {
        reply.replaceOutput = r.text;
        ctx.counters.rerunsShortened++;
        ctx.counters.tokensIn += item.tokens;
        ctx.counters.tokensOut += countTokens(r.text);
        return;
      }
      if (r.kind === "summary") preface = r.preface;
    }
  }
  if (!replaceable) return;
  const d = decideFold(
    {
      text: ev.output.text,
      isError: ev.output.isError,
      toolName: ev.tool.name,
      ...(intent ? { intent } : {}),
      ...(command ? { command } : {}),
      ...(pattern ? { pattern } : {}),
      ...(preface ? { preface } : {}),
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
