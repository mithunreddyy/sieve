import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPurge, archiveId, ProjectStore, planPurge } from "../src/index.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 11);

function open() {
  const d = mkdtempSync(join(tmpdir(), "sv-purge-"));
  const file = join(d, "db");
  const store = new ProjectStore({ key: "k", root: d, name: "x", worktree: d }, file);
  return { d, file, store };
}

/** Archive `text` as seen by `session`, indexed, with a few rows the purge has to find. */
function see(store: ProjectStore, text: string, session: string, at = NOW) {
  const item = store.put(text, {
    sessionId: session,
    worktree: store.project.worktree,
    agent: "claude-code",
    sourceKind: "tool",
    source: "Bash: x",
    at,
  });
  store.index(item.id);
  return item;
}
const count = (store: ProjectStore, sql: string, ...p: string[]) =>
  (store.db.query(sql).get(...p) as { n: number }).n;
const body = (tag: string) =>
  `${tag}\n${Array.from({ length: 200 }, (_, i) => `line ${i} of ${tag} lorem ipsum dolor sit amet`).join("\n")}`;

function sessionRows(store: ProjectStore, session: string, at = NOW) {
  store.db.run(
    "INSERT INTO sessions (id, agent, worktree, started_at, last_seen_at) VALUES (?, 'claude-code', ?, ?, ?)",
    [session, store.project.worktree, at, at],
  );
  store.db.run(
    "INSERT INTO session_log (session_id, seq, kind, context, worktree, summary, created_at) VALUES (?, 1, 'prompt', 'main', ?, 'a prompt', ?)",
    [session, store.project.worktree, at],
  );
  store.db.run("INSERT INTO state_blocks (session_id, upto_seq, body, built_at) VALUES (?, 1, 'state', ?)", [
    session,
    at,
  ]);
  store.db.run(
    "INSERT INTO folds (at, session_id, agent, tool, kind, tokens_in, tokens_out) VALUES (?, ?, 'claude-code', 'Bash', 'fold', 100, 10)",
    [at, session],
  );
}

describe("purge a session", () => {
  test("removes what only that session saw, keeps what another saw too, and a dry run changes nothing", () => {
    const { store } = open();
    const shared = see(store, body("shared"), "A");
    see(store, body("shared"), "B"); // same bytes: same id, a second sighting
    const onlyA = see(store, body("only-a"), "A");
    const onlyB = see(store, body("only-b"), "B");
    sessionRows(store, "A");
    sessionRows(store, "B");

    const plan = planPurge(store, { kind: "session", sessionId: "A" });
    expect(plan.items).toBe(1); // only-a; the shared item survives
    expect(plan.bytes).toBe(onlyA.bytes);
    expect(store.get(onlyA.id)).not.toBeNull(); // a dry run changed nothing
    expect(count(store, "SELECT COUNT(*) AS n FROM session_log")).toBe(2);

    const done = applyPurge(store, { kind: "session", sessionId: "A" }, "purge", NOW);
    expect(done.items).toBe(plan.items);
    expect(done.chunks).toBe(plan.chunks);
    expect(store.get(onlyA.id)).toBeNull();
    expect(count(store, "SELECT COUNT(*) AS n FROM chunks WHERE archive_id = ?", onlyA.id)).toBe(0);
    expect(store.get(shared.id)).not.toBeNull();
    expect(store.get(onlyB.id)).not.toBeNull();
    // A's own rows are gone, B's are intact
    for (const t of ["session_log", "state_blocks", "folds", "sessions"])
      expect(
        count(store, `SELECT COUNT(*) AS n FROM ${t} WHERE ${t === "sessions" ? "id" : "session_id"} = 'A'`),
      ).toBe(0);
    expect(count(store, "SELECT COUNT(*) AS n FROM session_log WHERE session_id = 'B'")).toBe(1);
    expect(count(store, "SELECT COUNT(*) AS n FROM sightings WHERE session_id = 'A'")).toBe(0);
    expect(count(store, "SELECT COUNT(*) AS n FROM sightings WHERE archive_id = ?", shared.id)).toBe(1);
    // searching no longer finds it, and still finds what stayed
    const hits = (q: string) =>
      count(store, "SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?", q);
    expect(hits('"only a"')).toBe(0);
    expect(hits('"only b"')).toBeGreaterThan(0);
    expect(store.tombstone(onlyA.id)?.reason).toBe("purge");
    expect(store.tombstone(shared.id)).toBeNull();
  });
});

describe("purge a project, or what is older than N days", () => {
  test("project: everything archived goes, with a tombstone each", () => {
    const { store } = open();
    const a = see(store, body("one"), "A");
    const b = see(store, body("two"), "B");
    sessionRows(store, "A");
    const done = applyPurge(store, { kind: "project" }, "purge", NOW);
    expect(done.items).toBe(2);
    expect(count(store, "SELECT COUNT(*) AS n FROM archive")).toBe(0);
    expect(count(store, "SELECT COUNT(*) AS n FROM chunks")).toBe(0);
    expect(count(store, "SELECT COUNT(*) AS n FROM sessions")).toBe(0);
    expect([store.tombstone(a.id)?.reason, store.tombstone(b.id)?.reason]).toEqual(["purge", "purge"]);
  });

  test("older than: unread items go, an item read recently stays, and the ledgers pointing at removed items go too", () => {
    const { store } = open();
    const old = see(store, body("old"), "A", NOW - 100 * DAY);
    const reread = see(store, body("reread"), "A", NOW - 100 * DAY);
    const fresh = see(store, body("fresh"), "A", NOW - DAY);
    // indexing reads an item (which refreshes its last-read time), so set the times after it
    const readAt = (id: string, at: number) =>
      store.db.run("UPDATE archive SET last_read_at = ? WHERE id = ?", [at, id]);
    readAt(old.id, NOW - 100 * DAY);
    readAt(reread.id, NOW - 2 * DAY); // read since
    readAt(fresh.id, NOW - DAY);
    store.db.run(
      "INSERT INTO runs (session_id, context, epoch, worktree, command_key, archive_id, run_no, created_at) VALUES ('A','main',0,?,'k',?,1,?)",
      [store.project.worktree, old.id, NOW],
    );
    store.db.run(
      "INSERT INTO reads (session_id, context, epoch, worktree, path, kind, content_id, size, mtime_ms, read_no, created_at) VALUES ('A','main',0,?,'/p','full',?,1,1,1,?)",
      [store.project.worktree, old.id, NOW],
    );

    const plan = planPurge(store, { kind: "older", days: 30, now: NOW });
    expect(plan.items).toBe(1);
    const done = applyPurge(store, { kind: "older", days: 30, now: NOW }, "retention", NOW);
    expect(done.items).toBe(1);
    expect(store.get(old.id)).toBeNull();
    expect(store.get(reread.id)).not.toBeNull();
    expect(store.get(fresh.id)).not.toBeNull();
    expect(count(store, "SELECT COUNT(*) AS n FROM runs")).toBe(0);
    expect(count(store, "SELECT COUNT(*) AS n FROM reads")).toBe(0);
    expect(store.tombstone(old.id)).toMatchObject({ reason: "retention" });
  });
});

describe("tombstones", () => {
  test("archiving the same output again clears the tombstone and the content expands again", () => {
    const { store } = open();
    const text = body("again");
    const first = see(store, text, "A");
    applyPurge(store, { kind: "project" }, "purge", NOW);
    expect(store.tombstone(first.id)).not.toBeNull();
    const second = see(store, text, "A");
    expect(second.id).toBe(first.id);
    expect(store.tombstone(first.id)).toBeNull();
    expect(store.get(first.id)?.text).toBe(text);
    expect(archiveId(text)).toBe(first.id);
  });
});

describe("deleted means gone from the file", () => {
  test("after purge and compaction the removed text is not in the database file or its log", () => {
    const { store, file } = open();
    const MARK = "ZEBRA-MARKER-7F3A9C"; // distinctive, not a secret
    const text = body(`secret-ish ${MARK}`);
    const keep = see(store, body("keepme KEEP-MARKER-11"), "B");
    const gone = see(store, text, "A");
    store.compact(); // flush to the main file so the marker is really on disk before the purge
    const raw = () =>
      [file, `${file}-wal`]
        .filter(existsSync)
        .map((f) => readFileSync(f).toString("latin1"))
        .join("");
    expect(raw().includes(MARK)).toBe(true); // the test would otherwise prove nothing (chunks hold it in plain text)
    applyPurge(store, { kind: "session", sessionId: "A" }, "purge", NOW);
    store.compact();
    expect(raw().includes(MARK)).toBe(false);
    expect(raw().includes("KEEP-MARKER-11")).toBe(true);
    expect(store.get(keep.id)).not.toBeNull();
    expect(store.get(gone.id)).toBeNull();
  });
});

describe("things a purge could trip over", () => {
  test("another session's decision that the purged session superseded: no foreign-key failure, and it is current again", () => {
    const { store } = open();
    const wt = store.project.worktree;
    store.db.run(
      "INSERT INTO decisions (id, worktree, topic, label, text, session_id, seq, created_at) VALUES (1, ?, 'db', 'use sqlite', 'sqlite', 'B', 1, ?)",
      [wt, NOW],
    );
    store.db.run(
      "INSERT INTO decisions (id, worktree, topic, label, text, session_id, seq, created_at) VALUES (2, ?, 'db', 'use postgres', 'postgres', 'A', 1, ?)",
      [wt, NOW],
    );
    store.db.run("UPDATE decisions SET superseded_by = 2 WHERE id = 1"); // A's decision replaced B's
    see(store, body("x"), "A");
    expect(() => applyPurge(store, { kind: "session", sessionId: "A" }, "purge", NOW)).not.toThrow();
    expect(count(store, "SELECT COUNT(*) AS n FROM decisions WHERE session_id = 'A'")).toBe(0);
    const b = store.db.query("SELECT superseded_by AS s FROM decisions WHERE id = 1").get() as {
      s: number | null;
    };
    expect(b.s).toBeNull(); // B's decision is the current one again, as if A had never decided
  });
});

describe("the search indexes are scrubbed too", () => {
  test("a whole word that was indexed is gone from the file after purge and compaction", () => {
    const { store, file } = open();
    const MARK = "zebramarker7f3a9c"; // one token, lower case: the form the FTS indexes hold it in
    const gone = see(store, body(`before ${MARK} after`), "A");
    see(store, body("keepme keepmarker11"), "B");
    store.compact();
    const raw = () =>
      [file, `${file}-wal`]
        .filter(existsSync)
        .map((f) => readFileSync(f).toString("latin1"))
        .join("")
        .toLowerCase();
    expect(raw().includes(MARK)).toBe(true); // present before: in the chunk text, and in the word index
    // and findable, so the index really holds it
    expect(
      count(store, "SELECT COUNT(*) AS n FROM chunks_words WHERE chunks_words MATCH ?", MARK),
    ).toBeGreaterThan(0);
    applyPurge(store, { kind: "session", sessionId: "A" }, "purge", NOW);
    store.compact();
    expect(raw().includes(MARK)).toBe(false);
    expect(raw().includes("keepmarker11")).toBe(true);
    expect(store.get(gone.id)).toBeNull();
  });
});
