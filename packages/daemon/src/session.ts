import { realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  ago,
  archiveId,
  commandKey,
  decisionsNote,
  errorLines,
  formatInt,
  hasRecallTerms,
  type ProjectRef,
  type ProjectStore,
  parseTodos,
  promptSummary,
  type ReaderRef,
  recallSearch,
  recallTerms,
  runReceiptFailed,
  STATE_LINE_BYTES,
  SUMMARY_MAX,
  THRESHOLDS,
  topicKey,
} from "@sieve/core";
import type { SieveEvent } from "@sieve/protocol";
import type { DaemonContext } from "./context.ts";
import { captureDecision } from "./memory.ts";

/**
 * Slice 4 on the hook path: one session-log row per step, the state block delivered after
 * compaction, recall pointers on prompts. Each hook does at most a few small inserts and
 * indexed lookups here; building the state block is queued after turn.end.
 */

type ToolAfter = Extract<SieveEvent, { kind: "tool.after" }>;

export interface SessionHooks {
  answeredQuestions?(
    toolName: string,
    input: unknown,
    response: unknown,
  ): Array<{
    header?: string;
    question: string;
    answer: string;
  }>;
  approvedPlan?(toolName: string, input: unknown, response: unknown): string | null;
  todoList?(toolName: string, input: unknown): Array<{ content: string; status: string }> | null;
  editedPath?(input: unknown): string | null;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** Programs whose output quotes files or history: an "Error" in it is content, not a failure. */
const READ_ONLY = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "grep",
  "egrep",
  "rg",
  "ag",
  "ack",
  "find",
  "fd",
  "ls",
  "tree",
  "sed",
  "awk",
  "jq",
  "yq",
  "wc",
  "echo",
  "printf",
  "diff",
  "bat",
  "file",
  "stat",
  "which",
  "type",
]);
const GIT_READ_ONLY = new Set(["log", "show", "diff", "grep", "blame", "status", "branch", "reflog"]);

/** The program that decides success: the first of the last `&&`/`;` segment, skipping env and sudo. */
export function mainProgram(command: string): { program: string; sub: string } {
  const seg = command.split(/&&|;|\|\|/).pop() ?? command;
  const words = (seg.split("|")[0] ?? "").trim().split(/\s+/);
  let i = 0;
  while (
    i < words.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || /^(sudo|env|time|nice|command)$/.test(words[i]!))
  )
    i++;
  const program = (words[i] ?? "").split("/").pop() ?? "";
  return { program, sub: words[i + 1] ?? "" };
}

function failureLooksReal(command: string): boolean {
  const { program, sub } = mainProgram(command);
  if (READ_ONLY.has(program)) return false;
  if (program === "git" && GIT_READ_ONLY.has(sub)) return false;
  return true;
}

/** A short label for a command in an error row: the command itself, or its program when long. */
function commandLabel(command: string): string {
  const c = command.replace(/\s+/g, " ").trim();
  if (c.length <= 80) return c;
  const { program, sub } = mainProgram(c);
  return `${program}${sub && !sub.startsWith("-") ? ` ${sub}` : ""} …`;
}

/** A path relative to the worktree (which is a real path: /tmp is /private/tmp on macOS). */
function worktreePath(worktree: string, abs: string): string {
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch {
    try {
      real = join(realpathSync(dirname(abs)), basename(abs)); // a file deleted since
    } catch {}
  }
  const rel = relative(worktree, real);
  return rel && !rel.startsWith("..") ? rel : real;
}

/** Log a prompt. Long prompts are archived so sieve_resume can return them exactly. */
export function logPrompt(
  ctx: DaemonContext,
  store: ProjectStore,
  ref: ProjectRef,
  reader: ReaderRef,
  prompt: string,
  at: number,
): void {
  const { summary, meaningful } = promptSummary(prompt);
  if (!summary) return;
  let detailId: string | null = null;
  if (summary.length > STATE_LINE_BYTES || summary.length > SUMMARY_MAX) {
    const item = store.put(prompt, {
      sessionId: reader.sessionId,
      worktree: ref.worktree,
      sourceKind: "log",
      source: "user prompt",
      at,
    });
    if (item.isNew) ctx.indexLater(store, item.id);
    detailId = item.id;
  }
  store.log.append(reader.sessionId, {
    kind: "prompt",
    context: reader.context,
    worktree: ref.worktree,
    summary,
    key: meaningful ? "request" : null,
    detailId,
    at,
  });
}

/** Log what a finished tool call did: an edit, a command (and its errors), a decision, the todo list. */
export function logTool(
  ctx: DaemonContext,
  hooks: SessionHooks,
  store: ProjectStore,
  ref: ProjectRef,
  reader: ReaderRef,
  agent: string,
  ev: ToolAfter,
  at: number,
): void {
  const base = { context: reader.context, worktree: ref.worktree, at };
  const input = (ev.input ?? {}) as Record<string, unknown>;
  const name = ev.tool.name;
  const log = store.log;

  if (ev.tool.family === "edit" && !ev.output.isError) {
    const p = hooks.editedPath?.(ev.input);
    if (!p) return;
    const rel = worktreePath(ref.worktree, resolve(ev.base.cwd, p));
    log.append(reader.sessionId, { ...base, kind: "edit", summary: `${name} ${rel}`, files: [rel] });
    return;
  }

  const answers = hooks.answeredQuestions?.(name, ev.input, ev.response) ?? [];
  for (const a of answers) {
    const label = a.header ?? a.question;
    const topic = topicKey(a.header, a.question);
    const seq = log.append(reader.sessionId, {
      ...base,
      kind: "decision",
      summary: `${a.question} → ${a.answer}`,
      key: topic,
    });
    log.decide(ref.worktree, { topic, label, text: a.answer, sessionId: reader.sessionId, seq, at });
    captureDecision(ctx, ref, label, `${a.question} → ${a.answer}`, at);
  }
  if (answers.length) return;

  const plan = !ev.output.isError ? hooks.approvedPlan?.(name, ev.input, ev.response) : null;
  if (plan) {
    const item = store.put(plan, {
      sessionId: reader.sessionId,
      worktree: ref.worktree,
      agent,
      sourceKind: "log",
      source: "approved plan",
      at,
    });
    if (item.isNew) ctx.indexLater(store, item.id);
    const title = (plan.split("\n").find((l) => l.trim()) ?? "plan").replace(/^#+\s*/, "").trim();
    const text = `approved "${title.length > 120 ? `${title.slice(0, 117)}...` : title}" (full plan: sieve_get {"id":"${item.id}"})`;
    const seq = log.append(reader.sessionId, {
      ...base,
      kind: "decision",
      summary: `plan approved: ${title}`,
      key: "plan|",
      detailId: item.id,
    });
    log.decide(ref.worktree, { topic: "plan|", label: "plan", text, sessionId: reader.sessionId, seq, at });
    return;
  }

  const todos = hooks.todoList?.(name, ev.input);
  if (todos) {
    // Whole items only, within the stored summary's cap, so the row stays valid JSON.
    const kept: typeof todos = [];
    for (const t of todos) {
      if (JSON.stringify([...kept, t]).length > SUMMARY_MAX) break;
      kept.push(t);
    }
    log.append(reader.sessionId, { ...base, kind: "todo", summary: JSON.stringify(kept) });
    return;
  }

  if (ev.tool.server === "sieve" && name.endsWith("sieve_index")) {
    const what = str(input.path) ?? str(input.title) ?? "content";
    log.append(reader.sessionId, { ...base, kind: "index", summary: `indexed ${what}` });
    return;
  }

  // Commands: the agent's shell tool, or Sieve's own sieve_run with a shell language.
  let command: string | undefined;
  let failed = false;
  if (ev.tool.family === "shell") {
    command = str(input.command);
    if (
      command &&
      (ev.output.isError || (failureLooksReal(command) && errorLines(ev.output.text, 1).total > 0))
    )
      failed = true;
  } else if (ev.tool.server === "sieve" && name.endsWith("sieve_run")) {
    const lang = str(input.language) ?? "";
    if (/^(shell|sh|bash|zsh)$/.test(lang)) command = str(input.code);
    failed = runReceiptFailed(ev.output.text);
  }
  if (!command) return;
  const key = commandKey(command);
  log.append(reader.sessionId, { ...base, kind: "command", summary: key, key });
  if (!failed) return;
  const { lines, total } = errorLines(ev.output.text, 1);
  const first = lines[0] ?? (ev.output.isError ? "the tool reported an error" : "failed");
  // The output is archived already when it was large enough to fold; small failing output is
  // archived here so the error row can point at it.
  let detailId: string;
  if (ev.output.text.length >= THRESHOLDS.passBelow) detailId = archiveId(ev.output.text);
  else {
    const item = store.put(ev.output.text || first, {
      sessionId: reader.sessionId,
      worktree: ref.worktree,
      agent,
      sourceKind: "tool",
      source: `${name}: ${key.slice(0, 200)}`,
      at,
    });
    if (item.isNew) ctx.indexLater(store, item.id);
    detailId = item.id;
  }
  const more = total > 1 ? ` (+${formatInt(total - 1)} more error lines)` : "";
  log.append(reader.sessionId, {
    ...base,
    kind: "error",
    summary: `${commandLabel(command)}: ${first}${more}`,
    key,
    detailId,
  });
}

// ------------------------------------------------------------------ state block

/** The state block for a session: the precomputed one if it is current, else built now. */
export function stateFor(store: ProjectStore, ref: ProjectRef, sessionId: string): string {
  return store.log.freshState(sessionId) ?? store.log.buildState(sessionId, ref.worktree, Date.now()).body;
}

/** After turn.end: rebuild the state block in the background, so compaction replies at once. */
export function buildStateLater(
  ctx: DaemonContext,
  store: ProjectStore,
  ref: ProjectRef,
  sessionId: string,
): void {
  ctx.queue.add("state-block", () => {
    if (store.log.freshState(sessionId) === null) store.log.buildState(sessionId, ref.worktree, Date.now());
  });
}

export function startupNote(store: ProjectStore, ref: ProjectRef): string {
  return decisionsNote(store.log.decisions(ref.worktree, 12));
}

// ------------------------------------------------------------------ recall

const RECALL_BYTES = 2048;

/** Up to 3 one-line pointers to earlier output matching the prompt's file names, symbols, or errors. */
export function recallNotice(
  ctx: DaemonContext,
  store: ProjectStore,
  ref: ProjectRef,
  reader: ReaderRef,
  prompt: string,
  now = Date.now(),
): string | null {
  const terms = recallTerms(prompt, (w) => store.hasSymbol(ref.worktree, w));
  if (!hasRecallTerms(terms)) return null;
  let skip = ctx.recalled.get(reader.sessionId);
  const hits = recallSearch(store.db, terms, {
    worktree: ref.worktree,
    sessionId: reader.sessionId,
    epochAt: store.epochAt(reader.sessionId),
    ...(skip ? { skip } : {}),
    limit: 3,
  });
  if (!hits.length) return null;
  if (!skip) {
    skip = new Set();
    ctx.recalled.set(reader.sessionId, skip);
  }
  const out = ["[sieve] Earlier output matching this request (pointers only; expand one if it helps):"];
  let used = Buffer.byteLength(out[0]!) + 1;
  for (const h of hits) {
    const src = h.source.length > 100 ? `${h.source.slice(0, 97)}...` : h.source;
    const what = h.stale ? `${src} (older version; the file changed since)` : src;
    const line = `- ${what} · ${ago(h.seenAt, now)} · sieve_get {"id":"${h.archiveId}","lines":"${h.startLine}-${h.endLine}"}`;
    if (used + Buffer.byteLength(line) + 1 > RECALL_BYTES) break;
    out.push(line);
    used += Buffer.byteLength(line) + 1;
    skip.add(h.archiveId);
  }
  return out.length > 1 ? out.join("\n") : null;
}

// ------------------------------------------------------------------ sieve_resume

const RESUME_DETAIL_BYTES = 16 * 1024;

export function resumeTool(
  store: ProjectStore,
  ref: ProjectRef,
  sessionId: string | null,
  seq?: number,
): {
  text: string;
  isError: boolean;
} {
  if (!sessionId)
    return { text: "No active session is known for this folder yet; nothing to resume.", isError: false };
  if (seq === undefined) {
    const body = stateFor(store, ref, sessionId);
    return { text: body || "The session log for this session is empty so far.", isError: false };
  }
  const row = store.log.row(sessionId, seq);
  if (!row) {
    const last = store.log.lastSeq(sessionId);
    return { text: `No row #${seq} in this session's log (it has ${last} row(s)).`, isError: true };
  }
  const out = [
    `#${row.seq} ${row.kind}${row.context !== "main" ? ` (${row.context})` : ""} · ${ago(row.createdAt)}`,
  ];
  if (row.kind === "todo") {
    for (const t of parseTodos(row.summary)) out.push(`- [${t.status}] ${t.content}`);
  } else out.push(row.summary);
  if (row.files.length) out.push(`files: ${row.files.join(", ")}`);
  if (row.detailId) {
    const info = store.info(row.detailId);
    if (!info) out.push(`(its archived detail ${row.detailId} has expired)`);
    else if (info.bytes <= RESUME_DETAIL_BYTES && row.kind === "prompt") {
      out.push("───", store.get(row.detailId)?.text ?? "");
    } else
      out.push(
        `detail: ${row.detailId} (${formatInt(info.tokens)} tokens). Expand: sieve_get {"id":"${row.detailId}"}`,
      );
  }
  return { text: out.join("\n"), isError: false };
}
