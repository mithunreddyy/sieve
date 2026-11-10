import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Migration = (db: Database) => void;

/** Open a WAL database and apply any migrations past `PRAGMA user_version`. */
export interface OpenOptions {
  /**
   * Turn off SQLite's automatic WAL checkpoint. The daemon checkpoints from its background
   * queue instead, because an automatic checkpoint runs inside whichever commit crosses the
   * threshold, and that is often a hook's archive insert (measured: up to ~115 ms).
   */
  manualCheckpoint?: boolean;
}

export function openDatabase(file: string, migrations: Migration[], opts: OpenOptions = {}): Database {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 2000");
  if (opts.manualCheckpoint) db.run("PRAGMA wal_autocheckpoint = 0");
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      migrations[v]!(db);
      db.run(`PRAGMA user_version = ${v + 1}`);
    })();
  }
  return db;
}

export const GLOBAL_MIGRATIONS: Migration[] = [
  (db) => {
    db.run(`CREATE TABLE projects (
      key TEXT PRIMARY KEY, root TEXT NOT NULL, name TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_open_at INTEGER NOT NULL)`);
    db.run(`CREATE TABLE agent_health (
      agent TEXT NOT NULL, event TEXT NOT NULL, last_at INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (agent, event))`);
  },
];

export const PROJECT_MIGRATIONS: Migration[] = [
  (db) => {
    db.run(`CREATE TABLE archive (
      id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, tokens INTEGER NOT NULL, tokenizer TEXT NOT NULL,
      lines INTEGER NOT NULL, content BLOB NOT NULL, created_at INTEGER NOT NULL,
      last_read_at INTEGER NOT NULL, indexed INTEGER NOT NULL DEFAULT 0)`);
    db.run(`CREATE TABLE sightings (
      id INTEGER PRIMARY KEY, archive_id TEXT NOT NULL REFERENCES archive(id) ON DELETE CASCADE,
      session_id TEXT, worktree TEXT NOT NULL, agent TEXT, source_kind TEXT NOT NULL,
      source TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    db.run("CREATE INDEX sightings_archive ON sightings(archive_id)");
    db.run("CREATE INDEX sightings_session ON sightings(session_id, created_at)");
    db.run(`CREATE TABLE chunks (
      id INTEGER PRIMARY KEY, archive_id TEXT NOT NULL REFERENCES archive(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL, is_code INTEGER NOT NULL DEFAULT 0, UNIQUE (archive_id, seq))`);
    db.run(`CREATE VIRTUAL TABLE chunks_fts USING fts5(title, body, content='chunks', content_rowid='id',
      tokenize='porter unicode61')`);
    db.run(`CREATE VIRTUAL TABLE chunks_tri USING fts5(title, body, content='chunks', content_rowid='id',
      tokenize='trigram')`);
    db.run(`CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
      INSERT INTO chunks_tri(rowid, title, body) VALUES (new.id, new.title, new.body);
    END`);
    db.run(`CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
      INSERT INTO chunks_tri(chunks_tri, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
    END`);
    db.run(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, agent TEXT NOT NULL, worktree TEXT NOT NULL, started_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL, ended_at INTEGER)`);
    db.run("CREATE INDEX sessions_worktree ON sessions(worktree, last_seen_at)");
  },
  // 2: vocabulary of the words as written (porter stores stems), for spelling suggestions.
  (db) => {
    db.run(`CREATE VIRTUAL TABLE chunks_words USING fts5(body, content='', contentless_delete=1, detail='none',
      tokenize='unicode61')`);
    db.run("CREATE VIRTUAL TABLE chunks_vocab USING fts5vocab(chunks_words, 'row')");
    db.run("INSERT INTO chunks_words(rowid, body) SELECT id, title || ' ' || body FROM chunks");
    db.run(`CREATE TRIGGER chunks_ai_words AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_words(rowid, body) VALUES (new.id, new.title || ' ' || new.body);
    END`);
    db.run(`CREATE TRIGGER chunks_ad_words AFTER DELETE ON chunks BEGIN
      DELETE FROM chunks_words WHERE rowid = old.id;
    END`);
  },
  // 3: watcher state, outline symbols, and per-context ledgers of reads and runs.
  (db) => {
    db.run("ALTER TABLE sessions ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0");
    db.run(`CREATE TABLE files (
      worktree TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL,
      content_id TEXT NOT NULL, lang TEXT, lines INTEGER NOT NULL, tokens INTEGER, updated_at INTEGER NOT NULL,
      PRIMARY KEY (worktree, path))`);
    db.run(`CREATE TABLE symbols (
      id INTEGER PRIMARY KEY, worktree TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, depth INTEGER NOT NULL,
      parent TEXT NOT NULL, signature TEXT NOT NULL)`);
    db.run("CREATE INDEX symbols_file ON symbols(worktree, path)");
    db.run("CREATE INDEX symbols_name ON symbols(name COLLATE NOCASE)");
    db.run(`CREATE TABLE reads (
      id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, context TEXT NOT NULL, epoch INTEGER NOT NULL,
      worktree TEXT NOT NULL, path TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('full','partial','outline','edit')),
      content_id TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, read_no INTEGER NOT NULL,
      created_at INTEGER NOT NULL)`);
    db.run("CREATE INDEX reads_lookup ON reads(session_id, context, path, id)");
    db.run(`CREATE TABLE runs (
      id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, context TEXT NOT NULL, epoch INTEGER NOT NULL,
      worktree TEXT NOT NULL, command_key TEXT NOT NULL, archive_id TEXT NOT NULL, run_no INTEGER NOT NULL,
      created_at INTEGER NOT NULL)`);
    db.run("CREATE INDEX runs_lookup ON runs(session_id, context, command_key, id)");
  },
];
