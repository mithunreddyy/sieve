import type { Database } from "bun:sqlite";
import { isErrorLine } from "./errors.ts";
import { cleanPrompt, intentTerms } from "./intent.ts";
import { queryTerms } from "./search.ts";
import { maskSecrets } from "./secrets.ts";
import { byteLength, cleanTerminal, formatInt } from "./text.ts";

/**
 * Session log, state blocks and decisions (slice 4). Everything here is built by rules from
 * rows in the project database; nothing reads a clock, so the same rows give the same bytes.
 */

export type LogKind = "prompt" | "edit" | "command" | "error" | "decision" | "index" | "todo";

export interface LogEntry {
  kind: LogKind;
  context: string;
  worktree: string;
  /** One line: the prompt, command, file, or error line. */
  summary: string;
  /** Command key (command/error), topic (decision), "request" (a prompt with content). */
  key?: string | null;
  files?: string[] | null;
  /** Archived original (a long prompt, a failing command's output, an approved plan). */
  detailId?: string | null;
  at: number;
}

export interface LogRow {
  seq: number;
  kind: LogKind;
  context: string;
  summary: string;
  key: string | null;
  files: string[];
  detailId: string | null;
  createdAt: number;
}

export interface DecisionRow {
  id: number;
  topic: string;
  /** Short label shown in the state block: the question's header, or the question. */
  label: string;
  text: string;
  sessionId: string | null;
  seq: number | null;
  createdAt: number;
}

export interface TodoItem {
  content: string;
  status: string;
}

/** At most this many bytes of state block (prompt.md §5). */
export const STATE_BLOCK_BYTES = 2048;
/** A row whose line would be longer than this becomes a sieve_resume pointer, never a cut line. */
export const STATE_LINE_BYTES = 280;
/** Rows read when building a state block; older rows are reachable with sieve_resume. */
const STATE_ROWS = 600;
/** Stored summaries are capped; the full original is archived as the row's detail. */
export const SUMMARY_MAX = 2000;

const oneLine = (s: string) => cleanTerminal(s).replace(/\s+/g, " ").trim();

/**
 * Topic key for supersession. Questions are matched by their header plus their content words,
 * so the same question asked again (reworded order, stopwords) replaces the earlier answer,
 * while two different questions under a common header ("Approach") stay separate.
 */
export function topicKey(header: string | undefined, question: string): string {
  const h = queryTerms(header ?? "").join(" ");
  const words = [...new Set(intentTerms(question).concat(queryTerms(question).filter((w) => w.length > 3)))]
    .sort()
    .slice(0, 12);
  return `${h}|${words.join(" ")}`;
}

/** Error and failure lines in command output (cleaned, whole lines, at most `max`). */
export function errorLines(text: string, max = 3): { lines: string[]; total: number } {
  const lines: string[] = [];
  let total = 0;
  // Bounded: a hook never scans more than 256 KB of output for this.
  for (const raw of text.slice(0, 256 * 1024).split("\n")) {
    if (!isErrorLine(raw)) continue;
    const l = oneLine(raw);
    if (!l) continue;
    total++;
    if (lines.length < max && !lines.includes(l)) lines.push(l);
  }
  return { lines, total };
}

/** Did a sieve_run receipt report a failure? (`[sieve run] exit 1 · …`, timed out, failed to start) */
export function runReceiptFailed(receipt: string): boolean {
  const m = /^\[sieve run\] (exit (\d+)|timed out|failed to start)/.exec(receipt);
  if (!m) return false;
  return m[2] === undefined || m[2] !== "0";
}

/** Prompt text worth logging: harness tags removed, whitespace collapsed. Empty → skip. */
export function promptSummary(prompt: string): { summary: string; meaningful: boolean } {
  const clean = cleanPrompt(prompt);
  return { summary: clean, meaningful: intentTerms(clean).length > 0 };
}

// ------------------------------------------------------------------ storage

export class SessionLog {
  constructor(private readonly db: Database) {}

  /** Append one row; returns its sequence number (1-based, per session). */
  append(sessionId: string, e: LogEntry): number {
    const seq =
      (
        this.db
          .query("SELECT COALESCE(MAX(seq), 0) AS n FROM session_log WHERE session_id = ?")
          .get(sessionId) as {
          n: number;
        }
      ).n + 1;
    // Rows are stored: secrets are masked first (so a cut can never split a secret's mask).
    const clean = maskSecrets(e.summary).text;
    const summary = clean.length > SUMMARY_MAX ? `${clean.slice(0, SUMMARY_MAX)}…` : clean;
    this.db.run(
      `INSERT INTO session_log (session_id, seq, kind, context, worktree, summary, key, files, detail_archive_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        seq,
        e.kind,
        e.context,
        e.worktree,
        summary,
        e.key == null ? null : maskSecrets(e.key).text,
        e.files?.length ? JSON.stringify(e.files.map((f) => maskSecrets(f).text)) : null,
        e.detailId ?? null,
        e.at,
      ],
    );
    return seq;
  }

  lastSeq(sessionId: string): number {
    return (
      this.db
        .query("SELECT COALESCE(MAX(seq), 0) AS n FROM session_log WHERE session_id = ?")
        .get(sessionId) as {
        n: number;
      }
    ).n;
  }

  row(sessionId: string, seq: number): LogRow | null {
    const r = this.db
      .query(`SELECT ${ROW_COLS} FROM session_log WHERE session_id = ? AND seq = ?`)
      .get(sessionId, seq) as RawRow | null;
    return r ? toRow(r) : null;
  }

  /** The newest `limit` rows after `afterSeq`, oldest first. */
  rows(sessionId: string, afterSeq = 0, limit = STATE_ROWS): LogRow[] {
    const rs = this.db
      .query(`SELECT ${ROW_COLS} FROM session_log WHERE session_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?`)
      .all(sessionId, afterSeq, limit) as RawRow[];
    return rs.reverse().map(toRow);
  }

  /** The first prompt with content after `afterSeq`: the session's goal. */
  firstRequest(sessionId: string, afterSeq = 0): LogRow | null {
    const r = this.db
      .query(
        `SELECT ${ROW_COLS} FROM session_log WHERE session_id = ? AND seq > ? AND kind = 'prompt' AND key = 'request'
         ORDER BY seq LIMIT 1`,
      )
      .get(sessionId, afterSeq) as RawRow | null;
    return r ? toRow(r) : null;
  }

  /** Rows since a /clear only: what came before was cleared by the user on purpose. */
  clearedSeq(sessionId: string): number {
    const r = this.db.query("SELECT cleared_seq FROM sessions WHERE id = ?").get(sessionId) as {
      cleared_seq: number;
    } | null;
    return r?.cleared_seq ?? 0;
  }

  markCleared(sessionId: string): void {
    this.db.run("UPDATE sessions SET cleared_seq = ? WHERE id = ?", [this.lastSeq(sessionId), sessionId]);
    this.db.run("DELETE FROM state_blocks WHERE session_id = ?", [sessionId]);
  }

  // ---------------------------------------------------------------- decisions

  /** Record a decision; an active decision on the same topic in this worktree is superseded. */
  decide(
    worktree: string,
    d: {
      topic: string;
      label: string;
      text: string;
      sessionId: string | null;
      seq: number | null;
      at: number;
    },
  ): number {
    let id = 0;
    const topic = maskSecrets(d.topic).text;
    const label = maskSecrets(d.label).text;
    const text = maskSecrets(d.text).text;
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO decisions (worktree, topic, label, text, session_id, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [worktree, topic, label, text, d.sessionId, d.seq, d.at],
      );
      id = (this.db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
      this.db.run(
        `UPDATE decisions SET superseded_by = ? WHERE worktree = ? AND topic = ? AND id <> ? AND superseded_by IS NULL`,
        [id, worktree, topic, id],
      );
    })();
    return id;
  }

  /** Decisions in force in a worktree, newest first. */
  decisions(worktree: string, limit = 20): DecisionRow[] {
    return this.db
      .query(
        `SELECT id, topic, label, text, session_id AS sessionId, seq, created_at AS createdAt FROM decisions
         WHERE worktree = ? AND superseded_by IS NULL ORDER BY id DESC LIMIT ?`,
      )
      .all(worktree, limit) as DecisionRow[];
  }

  /** How many decisions were replaced by a newer one on the same topic (for tests and status). */
  supersededCount(worktree: string): number {
    return (
      this.db
        .query("SELECT COUNT(*) AS n FROM decisions WHERE worktree = ? AND superseded_by IS NOT NULL")
        .get(worktree) as { n: number }
    ).n;
  }

  // ---------------------------------------------------------------- state blocks

  /** Build the state block from the log and store it. Returns the body ("" when there is nothing). */
  buildState(sessionId: string, worktree: string, at: number): { body: string; uptoSeq: number } {
    const cleared = this.clearedSeq(sessionId);
    const rows = this.rows(sessionId, cleared);
    const uptoSeq = rows.length ? rows[rows.length - 1]!.seq : 0;
    const goal = this.firstRequest(sessionId, cleared);
    const body = buildStateBlock({ uptoSeq, goal, rows, decisions: this.decisions(worktree, 8), sessionId });
    this.db.run(
      `INSERT INTO state_blocks (session_id, upto_seq, body, built_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET upto_seq = excluded.upto_seq, body = excluded.body, built_at = excluded.built_at`,
      [sessionId, uptoSeq, body, at],
    );
    return { body, uptoSeq };
  }

  /** The precomputed state block, if it covers every row logged so far. */
  freshState(sessionId: string): string | null {
    const r = this.db
      .query("SELECT upto_seq, body FROM state_blocks WHERE session_id = ?")
      .get(sessionId) as {
      upto_seq: number;
      body: string;
    } | null;
    // A /clear deletes the stored block (markCleared), so only newer rows can make it stale.
    if (!r || r.upto_seq !== this.lastSeq(sessionId)) return null;
    return r.body;
  }
}

const ROW_COLS =
  "seq, kind, context, summary, key, files, detail_archive_id AS detailId, created_at AS createdAt";
interface RawRow {
  seq: number;
  kind: LogKind;
  context: string;
  summary: string;
  key: string | null;
  files: string | null;
  detailId: string | null;
  createdAt: number;
}
function toRow(r: RawRow): LogRow {
  let files: string[] = [];
  if (r.files) {
    try {
      const v = JSON.parse(r.files);
      if (Array.isArray(v)) files = v.filter((x): x is string => typeof x === "string");
    } catch {}
  }
  return { ...r, files };
}

// ------------------------------------------------------------------ state block (pure)

export interface StateInput {
  uptoSeq: number;
  goal: LogRow | null;
  /** Rows since the last /clear, oldest first. */
  rows: LogRow[];
  /** Decisions in force for the worktree, newest first. */
  decisions: DecisionRow[];
  /** Only used to tell this session's decisions from earlier ones. */
  sessionId: string;
}

const resume = (seq: number) => `sieve_resume {"seq":${seq}}`;

/** A whole line for a row, or a pointer when the row does not fit on one line. */
function rowLine(prefix: string, text: string, seq: number, what: string): string {
  const line = `${prefix}${text}`;
  if (byteLength(line) <= STATE_LINE_BYTES) return line;
  return `${prefix}${what} (${formatInt(text.length)} chars), ${resume(seq)}`;
}

/** Open errors: per command, the error of its latest run, if that run failed. */
export function openErrors(rows: LogRow[]): LogRow[] {
  const open = new Map<string, LogRow | null>();
  for (const r of rows) {
    if (!r.key) continue;
    if (r.kind === "command") open.set(r.key, null);
    else if (r.kind === "error") open.set(r.key, r);
  }
  return [...open.values()].filter((r): r is LogRow => r !== null);
}

export function parseTodos(summary: string): TodoItem[] {
  try {
    const v = JSON.parse(summary);
    if (!Array.isArray(v)) return [];
    return v
      .filter((t) => t && typeof t.content === "string")
      .map((t) => ({ content: String(t.content), status: String(t.status ?? "pending") }));
  } catch {
    return [];
  }
}

/**
 * The state block: at most 2 KB of whole lines, in priority order (goal, last request, open
 * errors, decisions, next steps, files changed, search terms). Lines that do not fit are
 * counted in a closing pointer line. A pure function of its input.
 */
export function buildStateBlock(s: StateInput): string {
  if (!s.rows.length && !s.decisions.length) return "";
  const requests = s.rows.filter((r) => r.kind === "prompt" && r.key === "request");
  const last = requests[requests.length - 1] ?? null;
  type Section = { header?: string; lines: string[] };
  const sections: Section[] = [];

  if (s.goal) {
    const label = last && last.seq === s.goal.seq ? "goal and last request" : "goal";
    sections.push({
      lines: [rowLine(`${label} (#${s.goal.seq}): `, s.goal.summary, s.goal.seq, "a long request")],
    });
  }
  if (last && (!s.goal || last.seq !== s.goal.seq))
    sections.push({
      lines: [rowLine(`last request (#${last.seq}): `, last.summary, last.seq, "a long request")],
    });

  const errors = openErrors(s.rows);
  if (errors.length)
    sections.push({
      header: "open errors (latest run of each command failed):",
      lines: errors.reverse().map((e) => rowLine(`- #${e.seq} `, e.summary, e.seq, "an error")),
    });

  if (s.decisions.length)
    sections.push({
      header: "decisions in force:",
      lines: s.decisions.map((d) => decisionLine(d, s.sessionId)),
    });

  const todo = [...s.rows].reverse().find((r) => r.kind === "todo");
  if (todo) {
    const open = parseTodos(todo.summary).filter((t) => t.status !== "completed" && t.status !== "cancelled");
    if (open.length)
      sections.push({
        header: `next steps (todo list, #${todo.seq}):`,
        lines: open.map((t) =>
          rowLine(
            `- [${t.status === "in_progress" ? "in progress" : t.status}] `,
            oneLine(t.content),
            todo.seq,
            "a long item",
          ),
        ),
      });
  }

  const changed: string[] = [];
  for (const r of [...s.rows].reverse())
    if (r.kind === "edit") for (const f of r.files) if (!changed.includes(f)) changed.push(f);
  if (changed.length) sections.push({ lines: [listLine("files changed: ", changed)] });

  const terms: string[] = [];
  const addTerms = (ws: string[]) => {
    for (const w of ws) if (!terms.includes(w) && terms.length < 12) terms.push(w);
  };
  if (s.goal) addTerms(intentTerms(s.goal.summary));
  if (last) addTerms(intentTerms(last.summary));
  for (const f of changed.slice(0, 6))
    addTerms([
      f
        .split("/")
        .pop()!
        .replace(/\.[^.]+$/, "")
        .toLowerCase(),
    ]);
  if (terms.length) sections.push({ lines: [listLine("search terms (sieve_search): ", terms)] });

  const head = `[sieve state] from the session log, rows up to #${s.uptoSeq}. Any row in full: sieve_resume {"seq":N}`;
  const out: string[] = [head];
  let used = byteLength(head) + 1;
  let dropped = 0;
  const reserve = 64; // room for the closing "… N more" line
  for (const sec of sections) {
    let headerDone = !sec.header;
    for (const line of sec.lines) {
      const need = byteLength(line) + 1 + (headerDone ? 0 : byteLength(sec.header!) + 1);
      if (used + need > STATE_BLOCK_BYTES - reserve) {
        dropped++;
        continue;
      }
      if (!headerDone) {
        out.push(sec.header!);
        headerDone = true;
      }
      out.push(line);
      used += need;
    }
  }
  if (dropped) out.push(`… ${dropped} more line(s) did not fit; sieve_resume {} shows the log`);
  return out.join("\n");
}

function decisionLine(d: DecisionRow, sessionId: string | null): string {
  const here = d.sessionId === sessionId && d.seq;
  const line = `- ${d.label}: ${d.text} (${here ? `#${d.seq}` : "earlier session"})`;
  if (byteLength(line) <= STATE_LINE_BYTES) return line;
  const label = byteLength(d.label) <= 120 ? d.label : "a long question";
  return here
    ? `- ${label}: a long answer, ${resume(d.seq!)}`
    : `- ${label}: a long answer from an earlier session`;
}

/** At session start: the worktree's decisions in force, whole lines, at most 1 KB. "" if none. */
export function decisionsNote(decisions: DecisionRow[]): string {
  if (!decisions.length) return "";
  const out = [
    "[sieve] Decisions in force for this worktree (from earlier sessions; a newer answer replaces one):",
  ];
  let used = byteLength(out[0]!) + 1;
  let dropped = 0;
  for (const d of decisions) {
    const line = decisionLine(d, null);
    if (used + byteLength(line) + 1 > 1024 - 48) {
      dropped++;
      continue;
    }
    out.push(line);
    used += byteLength(line) + 1;
  }
  if (dropped) out.push(`… ${dropped} more: sieve_resume {}`);
  return out.join("\n");
}

/** "label: a, b, c (+N more)" as one whole line of at most STATE_LINE_BYTES. */
function listLine(label: string, items: string[]): string {
  let line = label;
  let n = 0;
  for (const it of items) {
    const next = `${n ? ", " : ""}${it}`;
    const rest = items.length - n - 1;
    const tail = rest > 0 ? ` (+${rest} more)` : "";
    if (byteLength(line + next + tail) > STATE_LINE_BYTES) break;
    line += next;
    n++;
  }
  if (n === 0) {
    // Not even the first item fits: say how many there are instead of cutting a name.
    return `${label}${items.length} (too long to list)`;
  }
  return n < items.length ? `${line} (+${items.length - n} more)` : line;
}
