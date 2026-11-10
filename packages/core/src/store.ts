import type { Database } from "bun:sqlite";
import { type Chunk, chunkText } from "./chunk.ts";
import { GLOBAL_MIGRATIONS, type OpenOptions, openDatabase, PROJECT_MIGRATIONS } from "./db.ts";
import { archiveId } from "./ids.ts";
import { paths } from "./paths.ts";
import type { ProjectRef } from "./project.ts";
import { countLines } from "./text.ts";
import { countTokens, TOKENIZER } from "./tokens.ts";

export interface ArchiveMeta {
  sessionId?: string | null;
  worktree: string;
  agent?: string | null;
  sourceKind: "tool" | "run" | "index" | "read";
  source: string;
  at?: number;
}

export interface ArchivedItem {
  id: string;
  bytes: number;
  tokens: number;
  tokenizer: string;
  lines: number;
  isNew: boolean;
}

export interface ArchiveRow {
  id: string;
  bytes: number;
  tokens: number;
  tokenizer: string;
  lines: number;
  createdAt: number;
  source: string | null;
}

/** One repo's database: archive, chunks + FTS, sightings, sessions. */
export class ProjectStore {
  readonly db: Database;
  /** Chunks of items being indexed in steps (see indexStep). */
  private pending = new Map<string, { chunks: Chunk[]; next: number }>();

  constructor(
    readonly project: ProjectRef,
    file = paths.projectDb(project.key),
    opts: OpenOptions = {},
  ) {
    this.db = openDatabase(file, PROJECT_MIGRATIONS, opts);
  }

  /** Move WAL content into the database without blocking readers or writers. */
  checkpoint(): void {
    this.db.run("PRAGMA wal_checkpoint(PASSIVE)");
  }

  /**
   * Store an original before anything is shortened. Content-addressed, so storing the same
   * bytes twice is a no-op apart from a new sighting. Returns the id and real token count.
   */
  put(content: string, meta: ArchiveMeta): ArchivedItem {
    const id = archiveId(content);
    const at = meta.at ?? Date.now();
    const existing = this.db
      .query("SELECT bytes, tokens, tokenizer, lines FROM archive WHERE id = ?")
      .get(id) as { bytes: number; tokens: number; tokenizer: string; lines: number } | null;
    let item: ArchivedItem;
    if (existing) {
      this.db.run("UPDATE archive SET last_read_at = ? WHERE id = ?", [at, id]);
      item = { id, ...existing, isNew: false };
    } else {
      const raw = Buffer.from(content, "utf8");
      item = {
        id,
        bytes: raw.length,
        tokens: countTokens(content),
        tokenizer: TOKENIZER,
        lines: countLines(content),
        isNew: true,
      };
      this.db.run(
        `INSERT INTO archive (id, bytes, tokens, tokenizer, lines, content, created_at, last_read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, item.bytes, item.tokens, item.tokenizer, item.lines, Bun.gzipSync(raw), at, at],
      );
    }
    this.db.run(
      `INSERT INTO sightings (archive_id, session_id, worktree, agent, source_kind, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, meta.sessionId ?? null, meta.worktree, meta.agent ?? null, meta.sourceKind, meta.source, at],
    );
    return item;
  }

  /** Exact original text, or a 1-based inclusive line range of it. Marks the item as read. */
  get(id: string, lines?: { from: number; to: number }): { text: string; totalLines: number } | null {
    const row = this.db.query("SELECT content FROM archive WHERE id = ?").get(id) as {
      content: Uint8Array<ArrayBuffer>;
    } | null;
    if (!row) return null;
    this.db.run("UPDATE archive SET last_read_at = ? WHERE id = ?", [Date.now(), id]);
    const text = Buffer.from(Bun.gunzipSync(row.content)).toString("utf8");
    const totalLines = countLines(text);
    if (!lines) return { text, totalLines };
    const all = text.split("\n");
    return { text: all.slice(Math.max(0, lines.from - 1), lines.to).join("\n"), totalLines };
  }

  info(id: string): ArchiveRow | null {
    return this.db
      .query(
        `SELECT a.id, a.bytes, a.tokens, a.tokenizer, a.lines, a.created_at AS createdAt,
           (SELECT source FROM sightings s WHERE s.archive_id = a.id ORDER BY s.id DESC LIMIT 1) AS source
         FROM archive a WHERE a.id = ?`,
      )
      .get(id) as ArchiveRow | null;
  }

  /** Chunk and index one archived item completely. Idempotent. */
  index(id: string): number {
    let n = 0;
    for (;;) {
      const r = this.indexStep(id, 1_000_000);
      n += r.inserted;
      if (r.done) return n;
    }
  }

  /**
   * Index up to `maxChunks` chunks of an item, so the daemon can interleave indexing with
   * hook replies instead of blocking on a large item. Re-running after a crash is safe
   * (chunks already present are skipped).
   */
  indexStep(id: string, maxChunks = 8): { done: boolean; inserted: number } {
    let p = this.pending.get(id);
    if (!p) {
      const row = this.db.query("SELECT indexed FROM archive WHERE id = ?").get(id) as {
        indexed: number;
      } | null;
      if (!row || row.indexed) return { done: true, inserted: 0 };
      const item = this.get(id);
      if (!item) return { done: true, inserted: 0 };
      const src = this.info(id)?.source ?? "";
      p = { chunks: chunkText(item.text, src.length > 80 ? `${src.slice(0, 77)}...` : src), next: 0 };
      this.pending.set(id, p);
    }
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO chunks (archive_id, seq, title, body, start_line, end_line, is_code)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const batch = p.chunks.slice(p.next, p.next + maxChunks);
    const done = p.next + batch.length >= p.chunks.length;
    this.db.transaction(() => {
      for (const c of batch) insert.run(id, c.seq, c.title, c.body, c.startLine, c.endLine, c.isCode ? 1 : 0);
      if (done) this.db.run("UPDATE archive SET indexed = 1 WHERE id = ?", [id]);
    })();
    p.next += batch.length;
    if (done) this.pending.delete(id);
    return { done, inserted: batch.length };
  }

  unindexed(limit = 10): string[] {
    return (
      this.db.query("SELECT id FROM archive WHERE indexed = 0 ORDER BY created_at LIMIT ?").all(limit) as {
        id: string;
      }[]
    ).map((r) => r.id);
  }

  touchSession(id: string, agent: string, worktree: string, at = Date.now()): void {
    this.db.run(
      `INSERT INTO sessions (id, agent, worktree, started_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      [id, agent, worktree, at, at],
    );
  }

  endSession(id: string, at = Date.now()): void {
    this.db.run("UPDATE sessions SET ended_at = ?, last_seen_at = ? WHERE id = ?", [at, at, id]);
  }

  /** The most recently active, not-ended session in a worktree (used for MCP calls). */
  currentSession(worktree: string, withinMs = 6 * 3600_000): string | null {
    const row = this.db
      .query(
        `SELECT id FROM sessions WHERE worktree = ? AND ended_at IS NULL AND last_seen_at > ?
         ORDER BY last_seen_at DESC LIMIT 1`,
      )
      .get(worktree, Date.now() - withinMs) as { id: string } | null;
    return row?.id ?? null;
  }

  totals(): { items: number; bytes: number; tokens: number; sightings: number } {
    return this.db
      .query(
        `SELECT COUNT(*) AS items, COALESCE(SUM(bytes),0) AS bytes, COALESCE(SUM(tokens),0) AS tokens,
           (SELECT COUNT(*) FROM sightings) AS sightings FROM archive`,
      )
      .get() as { items: number; bytes: number; tokens: number; sightings: number };
  }

  close(): void {
    this.db.close();
  }
}

/** Machine-wide state: project registry and per-agent hook health. */
export class GlobalStore {
  readonly db: Database;
  constructor(file = paths.globalDb(), opts: OpenOptions = {}) {
    this.db = openDatabase(file, GLOBAL_MIGRATIONS, opts);
  }

  checkpoint(): void {
    this.db.run("PRAGMA wal_checkpoint(PASSIVE)");
  }

  touchProject(p: ProjectRef, at = Date.now()): void {
    this.db.run(
      `INSERT INTO projects (key, root, name, created_at, last_open_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET last_open_at = excluded.last_open_at`,
      [p.key, p.root, p.name, at, at],
    );
  }

  recordHook(agent: string, event: string, at: number, n = 1): void {
    this.db.run(
      `INSERT INTO agent_health (agent, event, last_at, count) VALUES (?, ?, ?, ?)
       ON CONFLICT(agent, event) DO UPDATE SET last_at = MAX(last_at, excluded.last_at), count = count + excluded.count`,
      [agent, event, at, n],
    );
  }

  health(): Array<{ agent: string; event: string; lastAt: number; count: number }> {
    return this.db
      .query("SELECT agent, event, last_at AS lastAt, count FROM agent_health ORDER BY agent, event")
      .all() as Array<{ agent: string; event: string; lastAt: number; count: number }>;
  }

  projectCount(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
