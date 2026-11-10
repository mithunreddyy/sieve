import type { Database } from "bun:sqlite";

export interface SearchQuery {
  query: string;
  scope?: "session" | "worktree" | "project";
  sort?: "relevance" | "timeline";
  cursor?: string;
  sessionId?: string | null;
  worktree?: string;
  /** Restrict to these archived items (sieve_batch). */
  archiveIds?: string[];
  /** Replace words with zero matches by the closest indexed word (default true). */
  spellfix?: boolean;
  now?: number;
}

export interface SearchHit {
  archiveId: string;
  chunk: number;
  title: string;
  source: string;
  snippet: string;
  startLine: number;
  endLine: number;
  seenAt: number;
  stale: boolean;
  score: number;
}

export interface SearchPage {
  hits: SearchHit[];
  total: number;
  nextCursor: string | null;
  /** Words that had no match and were replaced by a close indexed word. */
  corrections: Array<{ from: string; to: string }>;
}

export const PAGE_SIZE = 5;
const CANDIDATES = 50;
const RRF_K = 60;
const HALF_LIFE_DAYS = 14;
const SESSION_BOOST = 1.25;
const SNIPPET_BYTES = 800;
const CODE_SNIPPET_BYTES = 2048;

export function queryTerms(q: string): string[] {
  const seen = new Set<string>();
  for (const m of q.toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)) seen.add(m[0]);
  return [...seen];
}

const quote = (t: string) => `"${t.replaceAll('"', '""')}"`;

function ranked(db: Database, table: "chunks_fts" | "chunks_tri", match: string): number[] {
  if (!match) return [];
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
 * Hybrid search: FTS5 porter (words) and trigram (partial names) lists fused by reciprocal
 * rank (k=60), then boosted by recency (14-day half-life) and by the current session.
 */
export function search(db: Database, q: SearchQuery): SearchPage {
  const corrections: SearchPage["corrections"] = [];
  const empty = (): SearchPage => ({ hits: [], total: 0, nextCursor: null, corrections });
  let terms = queryTerms(q.query);
  if (terms.length === 0) return empty();
  if (q.spellfix !== false) {
    terms = terms.map((t) => {
      if (hasMatch(db, t)) return t;
      const fix = suggest(db, t);
      if (fix) corrections.push({ from: t, to: fix });
      return fix ?? t;
    });
  }
  const now = q.now ?? Date.now();
  const words = ranked(db, "chunks_fts", terms.map(quote).join(" OR "));
  const grams = ranked(
    db,
    "chunks_tri",
    terms
      .filter((t) => t.length >= 3)
      .map(quote)
      .join(" OR "),
  );
  const rrf = new Map<number, number>();
  for (const list of [words, grams]) {
    list.forEach((id, rank) => {
      rrf.set(id, (rrf.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }
  if (rrf.size === 0) return empty();

  const ids = [...rrf.keys()];
  const params: (string | number)[] = [q.sessionId ?? "", ...ids];
  let scopeSql = "";
  const scope = q.scope ?? "project";
  if (scope === "session") {
    if (!q.sessionId) return empty();
    scopeSql = "AND s.session_id = ?";
    params.push(q.sessionId);
  } else if (scope === "worktree" && q.worktree) {
    scopeSql = "AND s.worktree = ?";
    params.push(q.worktree);
  }
  let idSql = "";
  if (q.archiveIds) {
    if (!q.archiveIds.length) return empty();
    idSql = `AND c.archive_id IN (${q.archiveIds.map(() => "?").join(",")})`;
    params.push(...q.archiveIds);
  }
  const rows = db
    .query(
      `SELECT c.id, c.archive_id AS archiveId, c.seq, c.title, c.body, c.is_code AS isCode,
         c.start_line AS startLine, c.end_line AS endLine,
         MAX(s.created_at) AS seenAt,
         MAX(CASE WHEN s.session_id = ? THEN 1 ELSE 0 END) AS inSession,
         (SELECT source FROM sightings x WHERE x.archive_id = c.archive_id ORDER BY x.id DESC LIMIT 1) AS source
       FROM chunks c JOIN sightings s ON s.archive_id = c.archive_id
       WHERE c.id IN (${ids.map(() => "?").join(",")}) ${scopeSql} ${idSql}
       GROUP BY c.id`,
    )
    .all(...params) as Array<{
    id: number;
    archiveId: string;
    seq: number;
    title: string;
    body: string;
    isCode: number;
    startLine: number;
    endLine: number;
    seenAt: number;
    inSession: number;
    source: string;
  }>;

  const hits: Array<SearchHit & { rowid: number }> = rows.map((r) => {
    const ageDays = Math.max(0, now - r.seenAt) / 86_400_000;
    const score =
      (rrf.get(r.id) ?? 0) * (1 + 2 ** (-ageDays / HALF_LIFE_DAYS)) * (r.inSession ? SESSION_BOOST : 1);
    return {
      rowid: r.id,
      archiveId: r.archiveId,
      chunk: r.seq,
      title: r.title,
      source: r.source,
      snippet: snippet(r.body, terms, r.isCode === 1),
      startLine: r.startLine,
      endLine: r.endLine,
      seenAt: r.seenAt,
      stale: false,
      score,
    };
  });
  if (q.sort === "timeline") hits.sort((a, b) => a.seenAt - b.seenAt || a.rowid - b.rowid);
  else hits.sort((a, b) => b.score - a.score || a.rowid - b.rowid);

  const offset = parseCursor(q.cursor);
  const page = hits.slice(offset, offset + PAGE_SIZE).map(({ rowid: _r, ...h }) => h);
  const next = offset + PAGE_SIZE < hits.length ? String(offset + PAGE_SIZE) : null;
  return { hits: page, total: hits.length, nextCursor: next, corrections };
}

function hasMatch(db: Database, term: string): boolean {
  const q = (table: string) => {
    try {
      return !!db.query(`SELECT 1 FROM ${table} WHERE ${table} MATCH ? LIMIT 1`).get(quote(term));
    } catch {
      return false;
    }
  };
  return q("chunks_fts") || (term.length >= 3 && q("chunks_tri"));
}

/** Damerau-Levenshtein (optimal string alignment) distance, stopping early above `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2: number[] = new Array(b.length + 1).fill(0);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, prev2[j - 2]! + 1);
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    prev2.splice(0, prev2.length, ...prev);
    prev = cur;
    if (rowMin > max) return max + 1;
  }
  return prev[b.length]!;
}

/**
 * The closest indexed word to a word with no matches: same first letter, within 1 edit for
 * words of up to 5 letters and 2 edits otherwise; ties go to the word in more chunks.
 */
export function suggest(db: Database, term: string): string | null {
  if (term.length < 4 || /\d/.test(term)) return null;
  const max = term.length <= 5 ? 1 : 2;
  const first = term[0]!;
  let rows: Array<{ term: string; doc: number }>;
  try {
    rows = db
      .query(
        "SELECT term, doc FROM chunks_vocab WHERE term >= ? AND term < ? AND length(term) BETWEEN ? AND ?",
      )
      .all(
        first,
        String.fromCodePoint(first.codePointAt(0)! + 1),
        term.length - max,
        term.length + max,
      ) as typeof rows;
  } catch {
    return null;
  }
  let best: { term: string; d: number; doc: number } | null = null;
  for (const r of rows) {
    if (r.term === term) continue;
    const d = editDistance(term, r.term, max);
    if (d > max) continue;
    if (
      !best ||
      d < best.d ||
      (d === best.d && (r.doc > best.doc || (r.doc === best.doc && r.term < best.term)))
    )
      best = { term: r.term, d, doc: r.doc };
  }
  return best?.term ?? null;
}

function parseCursor(c?: string): number {
  if (!c) return 0;
  const n = Number.parseInt(c, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** A window of whole lines around the first matching term, at most 800 B (2 KB for code). */
export function snippet(body: string, terms: string[], isCode: boolean): string {
  const limit = isCode ? CODE_SNIPPET_BYTES : SNIPPET_BYTES;
  if (Buffer.byteLength(body) <= limit) return body;
  const lines = body.split("\n");
  const lower = lines.map((l) => l.toLowerCase());
  let at = lower.findIndex((l) => terms.some((t) => l.includes(t)));
  if (at < 0) at = 0;
  const pick = new Set<number>([at]);
  let used = Buffer.byteLength(lines[at]!) + 1;
  let lo = at - 1;
  let hi = at + 1;
  while (lo >= 0 || hi < lines.length) {
    let grew = false;
    for (const i of [hi, lo]) {
      if (i < 0 || i >= lines.length) continue;
      const b = Buffer.byteLength(lines[i]!) + 1;
      if (used + b > limit) continue;
      pick.add(i);
      used += b;
      grew = true;
    }
    hi++;
    lo--;
    if (!grew && (lo < 0 || hi >= lines.length)) break;
    if (!grew && used > limit - 40) break;
  }
  const idx = [...pick].sort((a, b) => a - b);
  let out = idx.map((i) => lines[i]!).join("\n");
  if (Buffer.byteLength(out) > limit)
    out = Buffer.from(out).subarray(0, limit).toString("utf8").replace(/�$/, "");
  return out;
}
