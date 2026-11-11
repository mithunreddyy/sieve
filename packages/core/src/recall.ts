import type { Database } from "bun:sqlite";
import { isErrorLine } from "./errors.ts";
import { cleanPrompt, intentTerms } from "./intent.ts";
import { isStale, queryTerms } from "./search.ts";

/**
 * Recall pointers (slice 4): on a prompt, find earlier archived output that matches the prompt's
 * strong terms — file names, identifiers, and quoted or error text. Ordinary words never trigger
 * recall on their own, so a plain request ("tidy up the readme") adds nothing to the context.
 */

export interface RecallTerms {
  /** File names as written (basename), e.g. "auth.ts". Matched as substrings. */
  files: string[];
  /** Identifiers by shape (camelCase, PascalCase with an inner capital, snake_case) or known symbols. */
  idents: string[];
  /** Quoted text and error-looking lines from the prompt, each as its content words (all must match). */
  phrases: string[][];
}

const FILE_RE = /(?:^|[\s"'`([])((?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z][A-Za-z0-9]{0,5})(?=$|[\s"'`),:;\]?!])/g;
const IDENT_RE = /\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g;
const QUOTED_RE = /"([^"\n]{4,200})"|`([^`\n]{4,200})`/g;
/** Things that look like files in prose but are not ("e.g.", "v1.2"). */
const NOT_FILE = /^(e\.g|i\.e|etc|vs|v?\d+(\.\d+)+)$/i;

const MAX_TERMS = 8;
const MAX_PHRASES = 3;

function looksLikeIdent(w: string): boolean {
  if (/^[A-Z0-9_]+$/.test(w)) return /_/.test(w) && /[A-Z]/.test(w); // SCREAMING_SNAKE only
  return /[a-z][A-Z]/.test(w) || /[A-Za-z0-9]_[A-Za-z]/.test(w) || /^[A-Z][a-z]+[A-Z]/.test(w);
}

/**
 * Strong terms in a prompt. `isSymbol` checks plain words against the project's symbol index
 * (so "handler" stays ordinary unless the repo defines a symbol of that name).
 */
export function recallTerms(prompt: string, isSymbol?: (word: string) => boolean): RecallTerms {
  const text = cleanPrompt(prompt);
  const files: string[] = [];
  for (const m of text.matchAll(FILE_RE)) {
    const base = m[1]!.split("/").pop()!;
    if (NOT_FILE.test(base) || !/[A-Za-z]/.test(base.split(".")[0] ?? "")) continue;
    if (!files.includes(base)) files.push(base);
  }
  const fileWords = new Set(files.flatMap((f) => queryTerms(f)));
  const idents: string[] = [];
  for (const m of text.matchAll(IDENT_RE)) {
    const w = m[0];
    if (fileWords.has(w.toLowerCase()) || idents.includes(w)) continue;
    if (looksLikeIdent(w)) idents.push(w);
  }
  if (isSymbol)
    for (const w of intentTerms(text)) {
      if (w.length < 4 || fileWords.has(w) || idents.some((i) => i.toLowerCase() === w)) continue;
      if (isSymbol(w)) idents.push(w);
    }
  const phrases: string[][] = [];
  const addPhrase = (s: string) => {
    const ws = intentTerms(s, true);
    if (ws.length >= 2 && phrases.length < MAX_PHRASES && !phrases.some((p) => p.join(" ") === ws.join(" ")))
      phrases.push(ws);
  };
  for (const m of text.matchAll(QUOTED_RE)) addPhrase(m[1] ?? m[2] ?? "");
  // Error text pasted into the prompt (the raw prompt still has its lines).
  for (const line of prompt.split("\n")) if (isErrorLine(line)) addPhrase(line);
  return { files: files.slice(0, MAX_TERMS), idents: idents.slice(0, MAX_TERMS), phrases };
}

export const hasRecallTerms = (t: RecallTerms) => t.files.length + t.idents.length + t.phrases.length > 0;

export interface RecallHit {
  archiveId: string;
  source: string;
  sourceKind: string;
  startLine: number;
  endLine: number;
  seenAt: number;
  stale: boolean;
  /** How many of the prompt's strong terms this item matched. */
  matched: number;
}

export interface RecallOptions {
  worktree: string;
  /** Items this context has seen since this time are already in its window: never pointed at. */
  sessionId: string;
  epochAt: number;
  /** Items already pointed at in this epoch. */
  skip?: Set<string>;
  limit?: number;
}

const quote = (t: string) => `"${t.replaceAll('"', '""')}"`;
const CANDIDATES = 30;

function matchIds(db: Database, table: "chunks_fts" | "chunks_tri", match: string): number[] {
  try {
    return (
      db
        .query(
          `SELECT rowid FROM ${table} WHERE ${table} MATCH ? ORDER BY bm25(${table}) LIMIT ${CANDIDATES}`,
        )
        .all(match) as { rowid: number }[]
    ).map((r) => r.rowid);
  } catch {
    return [];
  }
}

/**
 * Archived items in this worktree that match the strong terms, best first: more distinct terms
 * matched wins, then the most recent sighting. Items the current context already saw, and file
 * snapshots identical to the file on disk (just read the file), are left out.
 */
export function recallSearch(db: Database, t: RecallTerms, o: RecallOptions): RecallHit[] {
  const lists: number[][] = [];
  for (const term of [...t.files, ...t.idents]) {
    if (term.length >= 3) lists.push(matchIds(db, "chunks_tri", quote(term)));
  }
  for (const words of t.phrases) lists.push(matchIds(db, "chunks_fts", words.map(quote).join(" ")));
  const perChunk = new Map<number, Set<number>>();
  lists.forEach((ids, termNo) => {
    for (const id of ids) {
      const s = perChunk.get(id) ?? new Set<number>();
      s.add(termNo);
      perChunk.set(id, s);
    }
  });
  if (!perChunk.size) return [];
  const ids = [...perChunk.keys()];
  const rows = db
    .query(
      `SELECT c.id, c.archive_id AS archiveId, c.start_line AS startLine, c.end_line AS endLine,
         (SELECT MAX(s.created_at) FROM sightings s WHERE s.archive_id = c.archive_id AND s.worktree = ?) AS seenAt,
         (SELECT COUNT(*) FROM sightings s WHERE s.archive_id = c.archive_id AND s.session_id = ? AND s.created_at >= ?) AS inWindow,
         (SELECT source FROM sightings x WHERE x.archive_id = c.archive_id ORDER BY x.id DESC LIMIT 1) AS source,
         (SELECT source_kind FROM sightings x WHERE x.archive_id = c.archive_id ORDER BY x.id DESC LIMIT 1) AS sourceKind
       FROM chunks c WHERE c.id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(o.worktree, o.sessionId, o.epochAt, ...ids) as Array<{
    id: number;
    archiveId: string;
    startLine: number;
    endLine: number;
    seenAt: number | null;
    inWindow: number;
    source: string;
    sourceKind: string;
  }>;
  const best = new Map<string, RecallHit & { terms: Set<number> }>();
  for (const r of rows) {
    if (r.seenAt === null || r.inWindow > 0 || o.skip?.has(r.archiveId)) continue;
    const terms = perChunk.get(r.id)!;
    const cur = best.get(r.archiveId);
    if (cur) {
      for (const x of terms) cur.terms.add(x);
      cur.matched = cur.terms.size;
      continue;
    }
    best.set(r.archiveId, {
      archiveId: r.archiveId,
      source: r.source,
      sourceKind: r.sourceKind,
      startLine: r.startLine,
      endLine: r.endLine,
      seenAt: r.seenAt,
      stale: false,
      matched: terms.size,
      terms: new Set(terms),
    });
  }
  const out: RecallHit[] = [];
  const sorted = [...best.values()].sort(
    (a, b) => b.matched - a.matched || b.seenAt - a.seenAt || (a.archiveId < b.archiveId ? -1 : 1),
  );
  for (const h of sorted) {
    if (out.length >= (o.limit ?? 3)) break;
    if (h.sourceKind === "read" || h.sourceKind === "index") {
      // A file snapshot is worth pointing at only if the file changed since (the old version).
      h.stale = isStale(db, h.archiveId, h.source, `${h.sourceKind}\u0000${o.worktree}`);
      if (!h.stale) continue;
    }
    const { terms: _t, ...hit } = h;
    out.push(hit);
  }
  return out;
}
