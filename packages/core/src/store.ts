import type { Database } from "bun:sqlite";
import { type Chunk, chunkText } from "./chunk.ts";
import { GLOBAL_MIGRATIONS, type OpenOptions, openDatabase, PROJECT_MIGRATIONS } from "./db.ts";
import { archiveId } from "./ids.ts";
import { Memory } from "./memory.ts";
import type { OutlineSymbol } from "./outline/index.ts";
import { paths } from "./paths.ts";
import type { ProjectRef } from "./project.ts";
import { EnvValues, type MaskResult, maskSecrets } from "./secrets.ts";
import { SessionLog } from "./session.ts";
import { countLines } from "./text.ts";
import { countTokens, TOKENIZER } from "./tokens.ts";

export interface ArchiveMeta {
  sessionId?: string | null;
  worktree: string;
  agent?: string | null;
  /** "log": the original behind a session-log row (a long prompt, an approved plan). */
  sourceKind: "tool" | "run" | "index" | "read" | "log";
  source: string;
  at?: number;
  /**
   * The content with secrets already masked, when the caller has computed it (the hook path
   * masks once and reuses it). The id is always derived from the original content.
   */
  masked?: string;
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

/** Who is reading: a session plus its agent context (main thread or one subagent). */
export interface ReaderRef {
  sessionId: string;
  /** "main", or the subagent's agent_id: subagents have their own context window. */
  context: string;
}

export interface FileState {
  size: number;
  mtimeMs: number;
  contentId: string;
}

export interface FileRow extends FileState {
  lines: number;
  lang: string | null;
  /** Real token count, when known (the watcher counts in the background). */
  tokens: number | null;
}

export interface ReadRow extends FileState {
  id: number;
  path: string;
  kind: "full" | "partial" | "outline" | "edit";
  readNo: number;
  epoch: number;
  createdAt: number;
}

export interface SymbolRow extends OutlineSymbol {
  path: string;
}

/** One repo's database: archive, chunks + FTS, sightings, sessions, files, symbols, ledgers. */
export class ProjectStore {
  readonly db: Database;
  /** Session log, state blocks and decisions (slice 4). */
  readonly log: SessionLog;
  private envValues = new EnvValues();
  /** Chunks of items being indexed in steps (see indexStep). */
  private pending = new Map<string, { chunks: Chunk[]; next: number }>();

  constructor(
    readonly project: ProjectRef,
    file = paths.projectDb(project.key),
    opts: OpenOptions = {},
  ) {
    this.db = openDatabase(file, PROJECT_MIGRATIONS, opts);
    this.log = new SessionLog(this.db);
  }

  /** Move WAL content into the database without blocking readers or writers. */
  checkpoint(): void {
    this.db.run("PRAGMA wal_checkpoint(PASSIVE)");
  }

  /**
   * Mask secrets in text bound for the database or a receipt: known key formats, private keys,
   * values assigned to secret-looking names, and the values in the worktree's .env files.
   */
  mask(text: string, worktree: string): string {
    return this.maskResult(text, worktree).text;
  }

  /** `mask`, with what was masked (for the header of a run result). */
  maskResult(text: string, worktree: string): MaskResult {
    return maskSecrets(text, { values: this.envValues.get(worktree) });
  }

  /**
   * Store an original before anything is shortened. Content-addressed (by the original bytes,
   * so a file's id matches the watcher's), so storing the same bytes twice is a no-op apart
   * from a new sighting. What is stored has its secrets masked: raw secrets never reach the
   * database, so sieve_get is exact except for `<secret:…>` tokens. Returns the id and real
   * token count (of the stored text).
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
      const raw = Buffer.from(meta.masked ?? this.mask(content, meta.worktree), "utf8");
      const stored = raw.toString("utf8");
      item = {
        id,
        bytes: raw.length,
        tokens: countTokens(stored),
        tokenizer: TOKENIZER,
        lines: countLines(stored),
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
      [
        id,
        meta.sessionId ?? null,
        meta.worktree,
        meta.agent ?? null,
        meta.sourceKind,
        maskSecrets(meta.source).text,
        at,
      ],
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
       ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at, ended_at = NULL`,
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

  // ------------------------------------------------------------- epochs
  /** The session's compaction epoch. Reads and runs from older epochs are not in context. */
  epoch(sessionId: string): number {
    const r = this.db.query("SELECT epoch FROM sessions WHERE id = ?").get(sessionId) as {
      epoch: number;
    } | null;
    return r?.epoch ?? 0;
  }

  /** Called on compaction or /clear: everything read before is no longer in the context window. */
  bumpEpoch(sessionId: string, at = Date.now()): number {
    this.db.run("UPDATE sessions SET epoch = epoch + 1, epoch_at = ? WHERE id = ?", [at, sessionId]);
    return this.epoch(sessionId);
  }

  /** When the session's current epoch began (0: the session start). */
  epochAt(sessionId: string): number {
    const r = this.db.query("SELECT epoch_at FROM sessions WHERE id = ?").get(sessionId) as {
      epoch_at: number;
    } | null;
    return r?.epoch_at ?? 0;
  }

  // ------------------------------------------------------------- reads
  recordRead(
    r: ReaderRef,
    worktree: string,
    path: string,
    kind: ReadRow["kind"],
    f: FileState,
    at = Date.now(),
  ): number {
    const prev = this.db
      .query(
        "SELECT COUNT(*) AS n FROM reads WHERE session_id = ? AND context = ? AND path = ? AND worktree = ? AND kind != 'edit'",
      )
      .get(r.sessionId, r.context, path, worktree) as { n: number };
    const readNo = kind === "edit" ? prev.n : prev.n + 1;
    this.db.run(
      `INSERT INTO reads (session_id, context, epoch, worktree, path, kind, content_id, size, mtime_ms, read_no, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.sessionId,
        r.context,
        this.epoch(r.sessionId),
        worktree,
        path,
        kind,
        f.contentId,
        f.size,
        f.mtimeMs,
        readNo,
        at,
      ],
    );
    return readNo;
  }

  /** The latest read (or own edit) of a file by this reader in the current epoch. */
  lastRead(r: ReaderRef, worktree: string, path: string): ReadRow | null {
    return this.db
      .query(
        `SELECT id, path, kind, content_id AS contentId, size, mtime_ms AS mtimeMs, read_no AS readNo, epoch,
           created_at AS createdAt
         FROM reads WHERE session_id = ? AND context = ? AND worktree = ? AND path = ? AND epoch = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(r.sessionId, r.context, worktree, path, this.epoch(r.sessionId)) as ReadRow | null;
  }

  /** Latest read of every file this reader has seen in the current epoch. */
  readsInEpoch(r: ReaderRef, worktree: string, limit = 200): ReadRow[] {
    return this.db
      .query(
        `SELECT id, path, kind, content_id AS contentId, size, mtime_ms AS mtimeMs, read_no AS readNo, epoch,
           created_at AS createdAt
         FROM reads WHERE id IN (
           SELECT MAX(id) FROM reads WHERE session_id = ? AND context = ? AND worktree = ? AND epoch = ? GROUP BY path)
         ORDER BY id DESC LIMIT ?`,
      )
      .all(r.sessionId, r.context, worktree, this.epoch(r.sessionId), limit) as ReadRow[];
  }

  // ------------------------------------------------------------- folds and command stats (slice 9)
  recordFold(r: {
    at: number;
    sessionId: string;
    agent: string;
    tool: string;
    kind: "fold" | "rerun" | "pass";
    extractor?: string | null;
    archiveId?: string | null;
    tokensIn: number;
    tokensOut: number;
    source?: string | null;
    canary?: boolean;
  }): void {
    this.db.run(
      `INSERT INTO folds (at, session_id, agent, tool, kind, extractor, archive_id, tokens_in, tokens_out, source, canary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.at,
        r.sessionId,
        r.agent,
        r.tool,
        r.kind,
        r.extractor ?? null,
        r.archiveId ?? null,
        r.tokensIn,
        r.tokensOut,
        r.source ?? null,
        r.canary ? 1 : 0,
      ],
    );
  }

  /** Remember how much a kind of command printed (for steering the next one). */
  bumpCommand(worktree: string, family: string, tokens: number, at = Date.now()): void {
    this.db.run(
      `INSERT INTO command_stats (worktree, family, runs, last_tokens, max_tokens, total_tokens, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(worktree, family) DO UPDATE SET runs = runs + 1, last_tokens = excluded.last_tokens,
         max_tokens = MAX(max_tokens, excluded.max_tokens), total_tokens = total_tokens + excluded.total_tokens,
         updated_at = excluded.updated_at`,
      [worktree, family, tokens, tokens, tokens, at],
    );
  }

  commandStat(
    worktree: string,
    family: string,
  ): { runs: number; lastTokens: number; maxTokens: number } | null {
    return this.db
      .query(
        "SELECT runs, last_tokens AS lastTokens, max_tokens AS maxTokens FROM command_stats WHERE worktree = ? AND family = ?",
      )
      .get(worktree, family) as { runs: number; lastTokens: number; maxTokens: number } | null;
  }

  // ------------------------------------------------------------- runs
  recordRun(r: ReaderRef, worktree: string, commandKey: string, archiveId: string, at = Date.now()): number {
    const prev = this.db
      .query(
        "SELECT COUNT(*) AS n FROM runs WHERE session_id = ? AND context = ? AND worktree = ? AND command_key = ?",
      )
      .get(r.sessionId, r.context, worktree, commandKey) as { n: number };
    this.db.run(
      `INSERT INTO runs (session_id, context, epoch, worktree, command_key, archive_id, run_no, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.sessionId, r.context, this.epoch(r.sessionId), worktree, commandKey, archiveId, prev.n + 1, at],
    );
    return prev.n + 1;
  }

  lastRun(r: ReaderRef, worktree: string, commandKey: string): { archiveId: string; runNo: number } | null {
    return this.db
      .query(
        `SELECT archive_id AS archiveId, run_no AS runNo FROM runs
         WHERE session_id = ? AND context = ? AND worktree = ? AND command_key = ? AND epoch = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(r.sessionId, r.context, worktree, commandKey, this.epoch(r.sessionId)) as {
      archiveId: string;
      runNo: number;
    } | null;
  }

  // ------------------------------------------------------------- files and symbols (watcher)
  getFile(worktree: string, path: string): FileRow | null {
    return this.db
      .query(
        "SELECT size, mtime_ms AS mtimeMs, content_id AS contentId, lines, lang, tokens FROM files WHERE worktree = ? AND path = ?",
      )
      .get(worktree, path) as FileRow | null;
  }

  /** Record a file's current state and, when given, replace its symbols. One transaction. */
  putFile(worktree: string, path: string, f: FileRow, symbols?: OutlineSymbol[] | null): void {
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO files (worktree, path, size, mtime_ms, content_id, lang, lines, tokens, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(worktree, path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
           content_id = excluded.content_id, lang = excluded.lang, lines = excluded.lines, tokens = excluded.tokens,
           updated_at = excluded.updated_at`,
        [worktree, path, f.size, f.mtimeMs, f.contentId, f.lang, f.lines, f.tokens, Date.now()],
      );
      if (symbols !== undefined) {
        this.db.run("DELETE FROM symbols WHERE worktree = ? AND path = ?", [worktree, path]);
        const ins = this.db.prepare(
          `INSERT INTO symbols (worktree, path, name, kind, start_line, end_line, depth, parent, signature)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const s of symbols ?? [])
          ins.run(
            worktree,
            path,
            s.name,
            s.kind,
            s.startLine,
            s.endLine,
            s.depth,
            s.parent,
            maskSecrets(s.signature).text,
          );
      }
    })();
  }

  deleteFile(worktree: string, path: string): void {
    this.db.transaction(() => {
      this.db.run("DELETE FROM files WHERE worktree = ? AND path = ?", [worktree, path]);
      this.db.run("DELETE FROM symbols WHERE worktree = ? AND path = ?", [worktree, path]);
    })();
  }

  fileCount(worktree: string): number {
    return (
      this.db.query("SELECT COUNT(*) AS n FROM files WHERE worktree = ?").get(worktree) as { n: number }
    ).n;
  }

  knownPaths(worktree: string): Map<string, FileState> {
    const rows = this.db
      .query("SELECT path, size, mtime_ms AS mtimeMs, content_id AS contentId FROM files WHERE worktree = ?")
      .all(worktree) as Array<FileState & { path: string }>;
    return new Map(rows.map((r) => [r.path, r]));
  }

  /** Code files indexed before outlines were available (no symbols recorded). */
  filesWithoutSymbols(worktree: string): string[] {
    return (
      this.db
        .query(
          `SELECT path FROM files f WHERE worktree = ? AND lang IS NOT NULL AND lang != 'markdown'
             AND NOT EXISTS (SELECT 1 FROM symbols s WHERE s.worktree = f.worktree AND s.path = f.path)`,
        )
        .all(worktree) as { path: string }[]
    ).map((r) => r.path);
  }

  symbolCount(worktree: string): number {
    return (
      this.db.query("SELECT COUNT(*) AS n FROM symbols WHERE worktree = ?").get(worktree) as { n: number }
    ).n;
  }

  symbolsFor(worktree: string, path: string): OutlineSymbol[] {
    return this.db
      .query(
        `SELECT name, kind, start_line AS startLine, end_line AS endLine, depth, parent, signature
         FROM symbols WHERE worktree = ? AND path = ? ORDER BY start_line, depth`,
      )
      .all(worktree, path) as OutlineSymbol[];
  }

  /** Symbols whose name contains any term (case-insensitive); exact names first. */
  findSymbols(worktree: string, terms: string[], limit = 8): SymbolRow[] {
    const ts = terms.filter((t) => t.length >= 3).slice(0, 5);
    if (!ts.length) return [];
    const where = ts.map(() => "name LIKE ? ESCAPE '\\' COLLATE NOCASE").join(" OR ");
    const like = ts.map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const rows = this.db
      .query(
        `SELECT path, name, kind, start_line AS startLine, end_line AS endLine, depth, parent, signature
         FROM symbols WHERE worktree = ? AND (${where}) LIMIT 200`,
      )
      .all(worktree, ...like) as SymbolRow[];
    const exact = new Set(ts.map((t) => t.toLowerCase()));
    return rows
      .sort(
        (a, b) =>
          Number(exact.has(b.name.toLowerCase())) - Number(exact.has(a.name.toLowerCase())) ||
          a.name.length - b.name.length ||
          a.path.localeCompare(b.path) ||
          a.startLine - b.startLine,
      )
      .slice(0, limit);
  }

  /** Does the worktree define a symbol with exactly this name (case-insensitive)? Uses symbols_name. */
  hasSymbol(worktree: string, name: string): boolean {
    return !!this.db
      .query("SELECT 1 FROM symbols WHERE name = ? COLLATE NOCASE AND worktree = ? LIMIT 1")
      .get(name, worktree);
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
  /** Long-term memory (slice 8). */
  readonly memory: Memory;
  constructor(file = paths.globalDb(), opts: OpenOptions = {}) {
    this.db = openDatabase(file, GLOBAL_MIGRATIONS, opts);
    this.memory = new Memory(this.db);
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
