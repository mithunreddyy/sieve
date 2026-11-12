import { closeSync, openSync, readSync, statSync } from "node:fs";
import * as claudeCode from "@sieve/adapter-claude-code";
import * as codex from "@sieve/adapter-codex";
import * as copilotCli from "@sieve/adapter-copilot-cli";
import * as cursor from "@sieve/adapter-cursor";
import * as geminiCli from "@sieve/adapter-gemini-cli";
import * as opencode from "@sieve/adapter-opencode";
import {
  byteLength,
  cleanPrompt,
  commandKey,
  compareRuns,
  countTokens,
  decideFold,
  intentTerms,
  lastUserPrompt,
  matchingLines,
  PREVIEW_WINDOW,
  type ProjectRef,
  type ProjectStore,
  previewNote,
  type ReaderRef,
  THRESHOLDS,
} from "@sieve/core";
import type { AgentCapabilities, HookResult, SieveEvent, SieveReply } from "@sieve/protocol";
import type { DaemonContext } from "./context.ts";
import { extractAfterTurn } from "./extraction.ts";
import { guardBefore } from "./guard.ts";
import { captureFromCommand, coreBlock, forgetShown, noteUserWords, relevantBlock } from "./memory.ts";
import { readPersisted } from "./persisted.ts";
import { type Hints, recordRead, smartReadBefore, staleNotice } from "./reads.ts";
import {
  buildStateLater,
  logPrompt,
  logTool,
  recallNotice,
  type SessionHooks,
  startupNote,
  stateFor,
} from "./session.ts";
import { skillNotice } from "./skills.ts";
import { steerable, steerBefore } from "./steer.ts";

export interface Adapter extends SessionHooks {
  capabilities: AgentCapabilities;
  toEvent(eventName: string, raw: unknown, at: number): SieveEvent | null;
  render(event: SieveEvent, reply: SieveReply, raw: unknown): string;
  /** Optional read support: agents with a file-read tool. */
  readRequest?(input: unknown): { path: string; full: boolean } | null;
  readWasWhole?(response: unknown): boolean;
  /** Whether a receipt can be written back into this result shape; absent: assumed yes. */
  canReplaceOutput?(response: unknown): boolean;
  editedPath?(input: unknown): string | null;
  readHints?: Hints;
}

export const ADAPTERS: Record<string, Adapter> = {
  [claudeCode.AGENT]: claudeCode,
  [geminiCli.AGENT]: geminiCli,
  [opencode.AGENT]: opencode,
  [cursor.AGENT]: cursor,
  [codex.AGENT]: codex,
  [copilotCli.AGENT]: copilotCli,
};

const PASS: HookResult = { stdout: "", exitCode: 0 };
type ToolAfter = Extract<SieveEvent, { kind: "tool.after" }>;

/** Deterministic: the same archived output is always, or never, in the audit sample. */
function canaryPick(sample: number, id: string): boolean {
  if (sample <= 0) return false;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 10_000;
  return h / 10_000 < sample;
}

function sourceOf(ev: ToolAfter): string {
  const input = (ev.input ?? {}) as Record<string, unknown>;
  const pick = input.command ?? input.file_path ?? input.url ?? input.pattern ?? input.query;
  const detail = typeof pick === "string" ? pick.replace(/\s+/g, " ").slice(0, 200) : "";
  return detail ? `${ev.tool.name}: ${detail}` : ev.tool.name;
}

/** May the agent's result for this tool be replaced with a receipt? */
function canReplace(caps: AgentCapabilities, ev: ToolAfter, adapter?: Adapter): boolean {
  if (caps.replace === "none") return false;
  // A shape the adapter cannot write a receipt into would be counted as saved yet reach the model whole
  // (found: every WebFetch result, for weeks). Only what can be replaced counts.
  if (adapter?.canReplaceOutput && !adapter.canReplaceOutput(ev.response)) return false;
  if (caps.replace === "mcp-only" && ev.tool.family !== "mcp") return false;
  // Sieve's own tools already return receipts or exact expansions; never fold them again.
  if (ev.tool.server === "sieve") return false;
  // File reads are handled before they run (smart reads); edits must reach the agent as they are.
  if (ev.tool.family === "read" || ev.tool.family === "edit") return false;
  return true;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/**
 * Replay a hook the shim spooled while the daemon was down, so a session's start and its first prompt
 * (the task) are not lost on a cold start. Only those two kinds: replaying a tool event would fold an
 * output the agent already received whole, and count a saving that never happened.
 */
export function replayHook(ctx: DaemonContext, agent: string, eventName: string, raw: unknown): boolean {
  const adapter = ADAPTERS[agent];
  const ev = adapter?.toEvent(eventName, raw, Date.now());
  if (!ev || (ev.kind !== "prompt.submit" && ev.kind !== "session.start")) return false;
  handleHook(ctx, agent, eventName, raw);
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
  const reader: ReaderRef = { sessionId: ev.base.sessionId, context: ev.base.context };

  const caps = adapter.capabilities;
  const sid = ev.base.sessionId;
  const reply: SieveReply = {};
  const notes: string[] = [];
  /** Deliver the state block now if this event can carry context, else on the next prompt. */
  const deliverState = (at: "session.start" | "compact.before") => {
    if (!ctx.config.session.state_block) return;
    if (caps.contextAt.includes(at)) {
      ctx.pendingState.delete(sid);
      const body = bestEffort(ctx, () => stateFor(store, ref, sid));
      if (body) notes.push(body);
    } else ctx.pendingState.add(sid);
  };
  switch (ev.kind) {
    case "session.start":
      // After compaction or /clear, nothing read before is in the context window any more.
      if (ev.source === "compact" || ev.source === "clear") newEpoch(ctx, store, reader);
      if (ev.source === "clear") bestEffort(ctx, () => store.log.markCleared(sid));
      if (ev.source === "compact") {
        ctx.compactUnconfirmed.delete(sid); // the compaction really happened
        deliverState("session.start");
      }
      // Without a compaction hook, a resumed session gets its state rebuilt from the log.
      if (ev.source === "resume" && !caps.events.includes("compact.before")) deliverState("session.start");
      if (ev.source === "startup" && caps.contextAt.includes("session.start")) {
        const note = bestEffort(ctx, () => startupNote(store, ref));
        if (note) notes.push(note);
      }
      // Memory: the core block now if this event can carry it, else with the first prompt.
      ctx.memoryDue.add(sid);
      if (caps.contextAt.includes("session.start")) {
        const core = bestEffort(ctx, () => coreBlock(ctx, ref));
        ctx.memoryCoreSent.add(sid);
        if (core) notes.push(core);
      }
      break;
    case "subagent.start": {
      // A subagent has its own context window: give it the core facts and what matches the task.
      const core = bestEffort(ctx, () => coreBlock(ctx, ref));
      if (core) notes.push(core);
      const last = ctx.lastPrompt.get(sid);
      const rel = last
        ? bestEffort(ctx, () => relevantBlock(ctx, ref, `${sid}|${ev.base.context}`, last, at))
        : null;
      if (rel) notes.push(rel);
      break;
    }
    case "compact.before":
      // Some agents signal an automatic compaction before checking whether to compact at all
      // (Gemini CLI fires PreCompress on every turn): only a manual one is a known reset there.
      if (caps.compaction === "manual-only" && ev.trigger === "auto") break;
      newEpoch(ctx, store, reader);
      if (caps.compactStart) ctx.compactUnconfirmed.add(sid);
      // Deliver now if this event carries context; otherwise wait for session.start(compact),
      // which clears the flag, or the next prompt, for agents that send no such start.
      if (caps.contextAt.includes("compact.before")) deliverState("compact.before");
      else ctx.pendingState.add(sid);
      break;
    case "turn.end":
      buildStateLater(ctx, store, ref, sid);
      // Optional, off by default: a model you chose suggests facts, on the background queue.
      if (ctx.config.memory.extraction.provider !== "off")
        ctx.queue.add("extract", () => {
          // Not awaited by the queue: a slow model must not hold up indexing. Tracked so tests can wait.
          const p = extractAfterTurn(ctx, store, ref, sid, at).then(() => {});
          ctx.inflight.add(p);
          void p.finally(() => ctx.inflight.delete(p));
        });
      break;
    case "session.end":
      store.endSession(sid, at);
      buildStateLater(ctx, store, ref, sid);
      break;
    case "prompt.submit": {
      const clean = cleanPrompt(ev.prompt);
      // Keep the last prompt that had content: "continue" or a tag-only prompt must not erase it.
      if (intentTerms(clean).length) ctx.lastPrompt.set(sid, clean.slice(0, 2000));
      // A compaction announced but never confirmed by its SessionStart was canceled: nothing to restore.
      if (ctx.compactUnconfirmed.delete(sid)) ctx.pendingState.delete(sid);
      if (ctx.pendingState.delete(sid) && ctx.config.session.state_block) {
        const body = bestEffort(ctx, () => stateFor(store, ref, sid));
        if (body) notes.push(body);
      }
      // Recall runs before this prompt is logged, so it cannot point at the prompt itself.
      const recall = ctx.config.session.recall
        ? bestEffort(ctx, () => recallNotice(ctx, store, ref, reader, ev.prompt, at))
        : null;
      bestEffort(ctx, () => logPrompt(ctx, store, ref, reader, ev.prompt, at));
      bestEffort(ctx, () => noteUserWords(ctx, sid, ev.prompt));
      if (!ctx.memoryCoreSent.has(sid)) {
        // First sight of this session (or its context was reset): the core facts, and the facts
        // that match this first request.
        ctx.memoryCoreSent.add(sid);
        ctx.memoryDue.add(sid);
        const core = bestEffort(ctx, () => coreBlock(ctx, ref));
        if (core) notes.push(core);
      }
      if (ctx.memoryDue.delete(sid)) {
        const rel = bestEffort(ctx, () => relevantBlock(ctx, ref, sid, clean, at));
        if (rel) notes.push(rel);
      }
      const skill = bestEffort(ctx, () =>
        skillNotice(ctx, sid, clean, !(caps.contextAt as string[]).includes("prompt.submit")),
      );
      if (skill) notes.push(skill);
      const stale = staleNotice(ctx, store, ref, reader);
      if (stale) notes.push(stale);
      if (recall) notes.push(recall);
      break;
    }
    case "tool.before": {
      // Guard first: a call that policy refuses (or hands to the agent's approval prompt) is not
      // also answered with an outline.
      const guarded = guardBefore(ctx, caps, ev, ref);
      if (guarded) {
        reply.decision = guarded;
        break;
      }
      const req = ev.tool.family === "read" ? adapter.readRequest?.(ev.input) : null;
      if (req?.full && adapter.readHints && adapter.capabilities.deny) {
        const msg = smartReadBefore(ctx, store, ref, reader, req.path, ev.base.cwd, adapter.readHints, {
          // Without a reliable compaction signal, what this reader read before may be gone.
          trustHistory: caps.compaction === "reliable",
        });
        if (msg) {
          reply.decision = { action: "deny", reason: msg, ruleId: "sieve.smart-read" };
          ctx.counters.readsDeclined++;
        }
      }
      // Steering: a read-only command that printed a lot last time is declined once.
      if (!reply.decision && ev.tool.family === "shell" && caps.deny) {
        const cmd = str((ev.input as Record<string, unknown> | undefined)?.command);
        const why = cmd
          ? bestEffort(ctx, () => steerBefore(ctx, store, ref.worktree, reader, cmd, ev.base.cwd, at))
          : null;
        if (why) reply.decision = { action: "deny", reason: why, ruleId: "sieve.steer" };
      }
      break;
    }
    case "tool.after":
      completeOutput(ev);
      afterTool(ctx, adapter, store, ref, reader, agent, ev, reply, at);
      // After afterTool, which archives large output: an error row points at that archive id.
      bestEffort(ctx, () => logTool(ctx, adapter, store, ref, reader, agent, ev, at));
      if (ev.tool.family === "shell" && !ev.output.isError)
        bestEffort(ctx, () =>
          captureFromCommand(
            ctx,
            ref,
            str((ev.input as Record<string, unknown> | undefined)?.command) ?? "",
            ev.output.text,
            at,
          ),
        );
      break;
  }
  // An event with no context slot parks its notes for the next tool result, if the agent has one.
  const viaTool = (caps.contextAt as string[]).includes("tool.after");
  if (notes.length && !(caps.contextAt as string[]).includes(ev.kind) && viaTool) {
    const q = ctx.pendingNotes.get(sid) ?? [];
    q.push(...notes);
    notes.length = 0;
    while (q.length > 4 || q.reduce((n, x) => n + x.length, 0) > 4096) q.shift(); // newest wins
    ctx.pendingNotes.set(sid, q);
  }
  if (ev.kind === "tool.after" && viaTool) {
    const q = ctx.pendingNotes.get(sid);
    if (q?.length) {
      notes.unshift(...q);
      ctx.pendingNotes.delete(sid);
    }
  }
  if (notes.length) reply.context = [reply.context, ...notes].filter(Boolean).join("\n\n");
  const stdout = adapter.render(ev, reply, raw);
  // What Sieve itself puts in front of the model, recorded only when it was actually delivered, so
  // `sieve stats` can report savings net of it. Guard's own refusals are safety, not overhead: not counted.
  if (stdout)
    bestEffort(ctx, () => {
      if (reply.context)
        store.recordInjection({
          at,
          sessionId: sid,
          agent,
          event: ev.kind,
          kind: "context",
          tokens: countTokens(reply.context),
        });
      const d = reply.decision;
      if (d?.reason && (d.ruleId === "sieve.smart-read" || d.ruleId === "sieve.steer"))
        store.recordInjection({
          at,
          sessionId: sid,
          agent,
          event: ev.kind,
          kind: "decision",
          tokens: countTokens(d.reason),
        });
    });
  ctx.health.record(agent, eventName || ev.kind, at, performance.now() - t0);
  return { stdout, exitCode: 0 };
}

/** Session bookkeeping must never cost the agent a fold or a reply: failures are counted, not thrown. */
function bestEffort<T>(ctx: DaemonContext, f: () => T): T | null {
  try {
    return f();
  } catch {
    ctx.counters.sessionErrors++;
    return null;
  }
}

function newEpoch(ctx: DaemonContext, store: ProjectStore, reader: ReaderRef): void {
  store.bumpEpoch(reader.sessionId);
  ctx.recalled.delete(reader.sessionId);
  // The context window is gone: the model must be told its facts again.
  forgetShown(ctx, reader.sessionId);
  ctx.skillsLoaded.delete(reader.sessionId);
  ctx.memoryDue.add(reader.sessionId);
  for (const k of ctx.notified.keys()) if (k.startsWith(`${reader.sessionId}|`)) ctx.notified.delete(k);
}

/**
 * A result the agent cut and kept whole in a file: archive the whole of it. When the file cannot be
 * trusted (see readPersisted) only what arrived is archived, and the receipt says so.
 */
function completeOutput(ev: ToolAfter): void {
  const p = ev.output.persisted;
  if (!p) return;
  const received = byteLength(ev.output.text);
  if (p.totalBytes <= received) {
    p.complete = true;
    return;
  }
  const whole = readPersisted(p, ev.output.text);
  if (whole !== null) ev.output.text = whole;
  p.complete = whole !== null;
}

/**
 * Lines of this output matching the user's last request, or null. Only for the main agent (a subagent's
 * task is not the user's prompt), never for web pages (their text would move into hook context, which a
 * model may trust more than a tool result), only where the agent takes context on this event, and only
 * when receipt plus note stays clearly smaller than the output. Built from the masked text.
 */
/** Largest transcript tail read to recover a missed prompt (once per session, on the hook path). */
const TRANSCRIPT_TAIL = 256 * 1024;

/**
 * The session's latest prompt, from the transcript when the daemon missed the prompt hook (it was not
 * running yet). Read once per session: the end of a regular .jsonl file, bounded.
 */
function promptFor(ctx: DaemonContext, ev: SieveEvent, sid: string): string | undefined {
  const known = ctx.lastPrompt.get(sid);
  if (known || !ev.base.transcriptPath || ctx.promptRecovered.has(sid)) return known;
  ctx.promptRecovered.add(sid);
  const p = ev.base.transcriptPath;
  if (!p.endsWith(".jsonl")) return undefined;
  const st = statSync(p, { throwIfNoEntry: false });
  if (!st?.isFile()) return undefined;
  const fd = openSync(p, "r");
  try {
    const len = Math.min(st.size, TRANSCRIPT_TAIL);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, st.size - len);
    const prompt = lastUserPrompt(buf.toString("utf8"));
    if (prompt) ctx.lastPrompt.set(sid, prompt.slice(0, 2000));
    return prompt ?? undefined;
  } finally {
    closeSync(fd);
  }
}

function matchNote(
  ctx: DaemonContext,
  adapter: Adapter,
  ev: ToolAfter,
  safe: string,
  receipt: string,
  sid: string,
  id?: string,
): string | null {
  if (!(adapter.capabilities.contextAt as string[]).includes("tool.after")) return null;
  if (ev.base.context !== "main" || ev.tool.family === "web") return null;
  const prompt = promptFor(ctx, ev, sid);
  if (!prompt) return null;
  const note = matchingLines(safe, prompt, receipt, id);
  if (!note) return null;
  return byteLength(receipt) + byteLength(note) < byteLength(safe) * 0.9 ? note : null;
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

  // Secrets are masked once, here: the archive, the rerun diff and the receipt all use the
  // masked text, so a secret can reach neither the database nor the model through Sieve.
  const safe = store.mask(ev.output.text, ref.worktree);
  const item = store.put(ev.output.text, {
    masked: safe,
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
  const rawCommand = ev.tool.family === "shell" ? str(input.command) : undefined;
  const command = rawCommand === undefined ? undefined : store.mask(rawCommand, ref.worktree);
  const pattern = str(input.pattern);
  const replaceable = canReplace(adapter.capabilities, ev, adapter);
  const canary = canaryPick(ctx.config.canary.sample, item.id);
  // A result the agent keeps in a file is shown to the model as a 2 KB preview, with or without
  // Sieve (measured live): savings are counted against that, not against the whole output.
  const pst = ev.output.persisted;
  const clip = (t: string) => (pst ? Buffer.from(t, "utf8").subarray(0, PREVIEW_WINDOW).toString("utf8") : t);
  const tokIn = pst ? countTokens(clip(ev.output.text)) : item.tokens;
  const tokOut = (t: string) => countTokens(clip(t));
  const partialOf = pst && !pst.complete ? pst.totalBytes : undefined;
  const previewLine = pst ? previewNote(item.id, byteLength(ev.output.text), partialOf) : undefined;
  // What the dashboard shows and steering learns from, kept for every large output.
  const note = (kind: "fold" | "rerun" | "pass", extractor: string | null, tokensOut: number) =>
    bestEffort(ctx, () =>
      store.recordFold({
        at,
        sessionId: reader.sessionId,
        agent,
        tool: ev.tool.name,
        kind,
        extractor,
        archiveId: item.id,
        tokensIn: tokIn,
        tokensOut,
        source: store.mask(sourceOf(ev), ref.worktree),
        canary: canary && kind !== "pass",
      }),
    );
  if (rawCommand)
    bestEffort(ctx, () => {
      const s = steerable(rawCommand, ev.base.cwd);
      if (s) store.bumpCommand(ref.worktree, s.family, item.tokens, at);
    });

  // Reruns: compare with the previous run of the same command by this reader in this epoch.
  // Not for a result the agent keeps in a file: it was shown only a 2 KB preview, so "same as run 1,
  // still in your context" would claim content it never received. It gets the receipt again instead.
  let preface: string | undefined;
  if (command && ctx.config.reruns.diff && !pst) {
    const key = commandKey(command);
    const prev = store.lastRun(reader, ref.worktree, key);
    store.recordRun(reader, ref.worktree, key, item.id, at);
    const prevText = prev ? store.get(prev.archiveId)?.text : undefined;
    const prevInfo = prev ? store.info(prev.archiveId) : null;
    if (prev && prevText !== undefined && prevInfo && replaceable) {
      const r = compareRuns(
        { runNo: prev.runNo, item: { ...prevInfo, isNew: false }, text: prevText },
        item,
        safe,
        { command, isError: ev.output.isError, toolName: ev.tool.name, ...(intent ? { intent } : {}) },
      );
      if (r.kind === "identical" || r.kind === "diff") {
        reply.replaceOutput = r.text;
        ctx.counters.rerunsShortened++;
        note("rerun", null, tokOut(r.text));
        ctx.counters.tokensIn += tokIn;
        ctx.counters.tokensOut += tokOut(r.text);
        return;
      }
      if (r.kind === "summary") preface = r.preface;
    }
  }
  if (!replaceable) {
    note("pass", null, tokIn);
    return;
  }
  const d = decideFold(
    {
      text: safe,
      isError: ev.output.isError,
      toolName: ev.tool.name,
      ...(intent ? { intent } : {}),
      ...(command ? { command } : {}),
      ...(pattern ? { pattern } : {}),
      ...(previewLine || preface ? { preface: [previewLine, preface].filter(Boolean).join("\n") } : {}),
      ...(pst ? { compact: true } : {}),
      ...(partialOf !== undefined ? { partialOf } : {}),
    },
    item,
  );
  if (d.kind === "replace") {
    reply.replaceOutput = d.text;
    // The lines that answer the user's last request, as a note next to the receipt (ADR 0023).
    const matched = bestEffort(ctx, () =>
      matchNote(ctx, adapter, ev, safe, d.text, reader.sessionId, item.id),
    );
    if (matched) reply.context = matched;
    ctx.counters.folds++;
    ctx.counters.tokensIn += tokIn;
    ctx.counters.tokensOut += tokOut(d.text);
    note("fold", d.extractor, tokOut(d.text));
  } else note("pass", null, tokIn);
}
