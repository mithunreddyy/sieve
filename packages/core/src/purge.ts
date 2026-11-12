import type { ProjectStore } from "./store.ts";

/**
 * Removing archived data on purpose: `sieve purge`, and retention (opt-in, off by default).
 *
 * Archive ids are content-addressed, so one row can be seen by several sessions: a session purge
 * removes only what no other session saw, and drops that session's own sightings of the rest.
 * Deleting an archive row cascades to its chunks (and so to the search indexes) and its sightings;
 * `reads` and `runs` point at archive ids without a foreign key, so they are deleted here.
 * Each removed id leaves a tombstone (id, when, why, size: never content), so `sieve_get` can say
 * what happened to an id in an old receipt.
 *
 * Memory facts live in the global database and are not touched (`sieve memory`). The `files` and
 * `symbols` tables (names and paths of the repository's code) are not archived output and stay.
 */

export type PurgeScope =
  | { kind: "session"; sessionId: string }
  | { kind: "project" }
  /** Items not read for `days` days, oldest first, at most `limit` (`now` is for tests). */
  | { kind: "older"; days: number; now?: number; limit?: number };

export interface PurgePlan {
  items: number;
  bytes: number;
  chunks: number;
  /** Session log, state block, decision, fold and ledger rows that go with a session or project purge. */
  rows: number;
}

/** Collect the ids to remove into a temp table, and count what removing them takes. */
function select(store: ProjectStore, scope: PurgeScope): PurgePlan {
  const db = store.db;
  db.run("DROP TABLE IF EXISTS temp.purge_ids");
  db.run("CREATE TEMP TABLE purge_ids (id TEXT PRIMARY KEY)");
  if (scope.kind === "project") db.run("INSERT INTO purge_ids SELECT id FROM archive");
  else if (scope.kind === "older") {
    const cutoff = (scope.now ?? Date.now()) - scope.days * 86_400_000;
    db.run(
      "INSERT INTO purge_ids SELECT id FROM archive WHERE last_read_at < ? ORDER BY last_read_at LIMIT ?",
      [cutoff, scope.limit ?? -1], // -1: no limit
    );
  } else
    db.run(
      `INSERT INTO purge_ids
       SELECT DISTINCT archive_id FROM sightings WHERE session_id = ?1
         AND archive_id NOT IN (SELECT archive_id FROM sightings WHERE session_id IS NOT ?1)`,
      [scope.sessionId],
    );
  const one = (sql: string, ...p: string[]) => (db.query(sql).get(...p) as { n: number }).n;
  const items = one("SELECT COUNT(*) AS n FROM purge_ids");
  const bytes = one(
    "SELECT COALESCE(SUM(bytes), 0) AS n FROM archive WHERE id IN (SELECT id FROM purge_ids)",
  );
  const chunks = one("SELECT COUNT(*) AS n FROM chunks WHERE archive_id IN (SELECT id FROM purge_ids)");
  let rows = 0;
  if (scope.kind === "session") {
    const s = scope.sessionId;
    for (const t of ["session_log", "state_blocks", "decisions", "folds", "reads", "runs"])
      rows += one(`SELECT COUNT(*) AS n FROM ${t} WHERE session_id = ?`, s);
    rows += one("SELECT COUNT(*) AS n FROM sessions WHERE id = ?", s);
  } else if (scope.kind === "project") {
    for (const t of [
      "session_log",
      "state_blocks",
      "decisions",
      "folds",
      "reads",
      "runs",
      "sessions",
      "command_stats",
    ])
      rows += one(`SELECT COUNT(*) AS n FROM ${t}`);
  }
  return { items, bytes, chunks, rows };
}

/** What a purge would remove. Changes nothing. */
export function planPurge(store: ProjectStore, scope: PurgeScope): PurgePlan {
  try {
    return select(store, scope);
  } finally {
    store.db.run("DROP TABLE IF EXISTS temp.purge_ids");
  }
}

/**
 * Remove it. The caller should compact afterwards (`store.compact()`) before saying it is gone:
 * until then the bytes can still sit in free pages and the WAL. Freed pages are overwritten (secure_delete).
 */
export function applyPurge(
  store: ProjectStore,
  scope: PurgeScope,
  reason: "purge" | "retention",
  at = Date.now(),
): PurgePlan {
  const db = store.db;
  const secure = (db.query("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete;
  db.run("PRAGMA secure_delete = ON");
  try {
    let plan!: PurgePlan;
    db.transaction(() => {
      plan = select(store, scope);
      db.run(
        `INSERT OR REPLACE INTO tombstones (id, removed_at, reason, bytes)
         SELECT id, ?, ?, bytes FROM archive WHERE id IN (SELECT id FROM purge_ids)`,
        [at, reason],
      );
      // pointers that have no foreign key
      db.run("DELETE FROM runs WHERE archive_id IN (SELECT id FROM purge_ids)");
      db.run("DELETE FROM reads WHERE content_id IN (SELECT id FROM purge_ids)");
      db.run("DELETE FROM archive WHERE id IN (SELECT id FROM purge_ids)"); // cascades: chunks, sightings
      if (scope.kind === "session") {
        const s = scope.sessionId;
        // `decisions.superseded_by` has no delete action: another session's decision that this session's
        // replaced becomes the current one again, as if this session had never decided.
        db.run(
          "UPDATE decisions SET superseded_by = NULL WHERE superseded_by IN (SELECT id FROM decisions WHERE session_id = ?)",
          [s],
        );
        db.run("DELETE FROM sightings WHERE session_id = ?", [s]);
        for (const t of ["session_log", "state_blocks", "decisions", "folds", "reads", "runs"])
          db.run(`DELETE FROM ${t} WHERE session_id = ?`, [s]);
        db.run("DELETE FROM sessions WHERE id = ?", [s]);
      } else if (scope.kind === "project") {
        for (const t of [
          "sightings",
          "session_log",
          "state_blocks",
          "decisions",
          "folds",
          "reads",
          "runs",
          "sessions",
          "command_stats",
        ])
          db.run(`DELETE FROM ${t}`);
      }
    })();
    return plan;
  } finally {
    db.run("DROP TABLE IF EXISTS temp.purge_ids");
    db.run(`PRAGMA secure_delete = ${secure ? "ON" : "OFF"}`);
  }
}
