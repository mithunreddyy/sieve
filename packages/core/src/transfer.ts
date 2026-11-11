import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import type { ProjectStore } from "./store.ts";

/**
 * Moving a session between machines (slice 11): its log, state block, decisions, and the archived
 * output it points at, as one JSON bundle.
 *
 * What travels is what Sieve already stored, which is masked (`<secret:kind#N>`): a bundle holds no
 * raw secrets. It does hold your project's code and command output, so treat a bundle like the
 * project itself; `--encrypt` seals it with a passphrase.
 *
 * Archive ids are hashes of the *original* bytes, which Sieve does not keep when it masked
 * something. An imported item keeps its id so the log still points at it, but its content cannot
 * be re-hashed to check the id. The bundle is checked for shape and size, not for authorship;
 * only an encrypted bundle is authenticated.
 */

const MAX_ITEM = 4 * 1024 * 1024;
const MAX_ITEMS = 2000;
const MAX_ROWS = 50_000;

const Str = z.string().max(2_000_000);
const Item = z
  .object({
    id: z.string().regex(/^s_[a-z2-7]{4,64}$/),
    bytes: z.number().int().min(0),
    tokens: z.number().int().min(0),
    tokenizer: z.string().max(40),
    lines: z.number().int().min(0),
    created_at: z.number().int(),
    /** gzip of the (masked) text, base64 */
    gz: z.string().max(MAX_ITEM * 2),
  })
  .strict();
const LogRow = z
  .object({
    seq: z.number().int().min(1),
    kind: z.enum(["prompt", "edit", "command", "error", "decision", "index", "todo"]),
    context: z.string().max(200),
    summary: Str,
    key: z.string().max(500).nullable(),
    files: z.string().max(100_000).nullable(),
    detail_archive_id: z.string().max(80).nullable(),
    created_at: z.number().int(),
  })
  .strict();

export const SessionBundle = z
  .object({
    format: z.literal("sieve-session-v1"),
    exportedAt: z.number().int(),
    /** Normalised git remote of the project, so the other machine can tell it is the same repo. */
    remote: z.string().max(300).nullable(),
    session: z
      .object({
        id: z.string().min(1).max(200),
        agent: z.string().max(80),
        started_at: z.number().int(),
        last_seen_at: z.number().int(),
        ended_at: z.number().int().nullable(),
        epoch: z.number().int(),
        epoch_at: z.number().int(),
        cleared_seq: z.number().int(),
      })
      .strict(),
    log: z.array(LogRow).max(MAX_ROWS),
    stateBlock: z
      .object({ upto_seq: z.number().int(), body: Str, built_at: z.number().int() })
      .strict()
      .nullable(),
    decisions: z
      .array(
        z
          .object({
            topic: z.string().max(500),
            label: z.string().max(500),
            text: Str,
            seq: z.number().int().nullable(),
            created_at: z.number().int(),
            superseded: z.boolean(),
          })
          .strict(),
      )
      .max(5000),
    archive: z.array(Item).max(MAX_ITEMS),
    sightings: z
      .array(
        z
          .object({
            archive_id: z.string().max(80),
            agent: z.string().max(80).nullable(),
            source_kind: z.string().max(40),
            source: Str,
            created_at: z.number().int(),
          })
          .strict(),
      )
      .max(MAX_ROWS),
  })
  .strict();
export type SessionBundle = z.infer<typeof SessionBundle>;

export interface ExportOptions {
  remote?: string | null;
  now?: number;
  /** Skip archived items larger than this (default 2 MB compressed). */
  maxItemBytes?: number;
}

export function exportSession(
  store: ProjectStore,
  sessionId: string,
  opts: ExportOptions = {},
): { bundle: SessionBundle; skipped: number } {
  const db = store.db;
  const s = db
    .query(
      "SELECT id, agent, started_at, last_seen_at, ended_at, epoch, epoch_at, cleared_seq FROM sessions WHERE id = ?",
    )
    .get(sessionId) as SessionBundle["session"] | null;
  if (!s) throw new Error(`no session ${sessionId} in this project`);
  const log = db
    .query(
      "SELECT seq, kind, context, summary, key, files, detail_archive_id, created_at FROM session_log WHERE session_id = ? ORDER BY seq",
    )
    .all(sessionId) as SessionBundle["log"];
  const stateBlock =
    (db
      .query("SELECT upto_seq, body, built_at FROM state_blocks WHERE session_id = ?")
      .get(sessionId) as SessionBundle["stateBlock"]) ?? null;
  const decisions = (
    db
      .query(
        "SELECT topic, label, text, seq, created_at, superseded_by IS NOT NULL AS superseded FROM decisions WHERE session_id = ? ORDER BY id",
      )
      .all(sessionId) as Array<{
      topic: string;
      label: string;
      text: string;
      seq: number | null;
      created_at: number;
      superseded: number;
    }>
  ).map((d) => ({ ...d, superseded: !!d.superseded }));
  const sightings = db
    .query(
      "SELECT archive_id, agent, source_kind, source, created_at FROM sightings WHERE session_id = ? ORDER BY id",
    )
    .all(sessionId) as SessionBundle["sightings"];
  const ids = new Set<string>(sightings.map((x) => x.archive_id));
  for (const r of log) if (r.detail_archive_id) ids.add(r.detail_archive_id);
  const cap = opts.maxItemBytes ?? 2 * 1024 * 1024;
  const archive: SessionBundle["archive"] = [];
  let skipped = 0;
  for (const id of ids) {
    const r = db
      .query("SELECT id, bytes, tokens, tokenizer, lines, created_at, content FROM archive WHERE id = ?")
      .get(id) as {
      id: string;
      bytes: number;
      tokens: number;
      tokenizer: string;
      lines: number;
      created_at: number;
      content: Uint8Array;
    } | null;
    if (!r) continue;
    if (r.content.length > cap || archive.length >= MAX_ITEMS) {
      skipped++;
      continue;
    }
    archive.push({
      id: r.id,
      bytes: r.bytes,
      tokens: r.tokens,
      tokenizer: r.tokenizer,
      lines: r.lines,
      created_at: r.created_at,
      gz: Buffer.from(r.content).toString("base64"),
    });
  }
  const kept = new Set(archive.map((a) => a.id));
  return {
    bundle: {
      format: "sieve-session-v1",
      exportedAt: opts.now ?? Date.now(),
      remote: opts.remote ?? null,
      session: s,
      // a row whose detail did not travel loses the pointer rather than pointing at nothing
      log: log.map((r) =>
        r.detail_archive_id && !kept.has(r.detail_archive_id) ? { ...r, detail_archive_id: null } : r,
      ),
      stateBlock,
      decisions,
      archive,
      sightings: sightings.filter((x) => kept.has(x.archive_id)),
    },
    skipped,
  };
}

export interface ImportResult {
  sessionId: string;
  rows: number;
  items: number;
  newItems: number;
}

export function importSession(
  store: ProjectStore,
  worktree: string,
  raw: unknown,
  opts: { as?: string } = {},
): ImportResult {
  const b = SessionBundle.parse(raw);
  const id = opts.as ?? b.session.id;
  const db = store.db;
  if (db.query("SELECT 1 FROM sessions WHERE id = ?").get(id))
    throw new Error(`session ${id} already exists here; import it under another id with --as`);
  let newItems = 0;
  db.transaction(() => {
    for (const it of b.archive) {
      const gz = Buffer.from(it.gz, "base64");
      // cheap integrity check: it must decompress and match the recorded size
      const text = gunzipSync(gz);
      if (text.length !== it.bytes && text.length > MAX_ITEM)
        throw new Error(`archive item ${it.id} is malformed`);
      const r = db.run(
        "INSERT OR IGNORE INTO archive (id, bytes, tokens, tokenizer, lines, content, created_at, last_read_at, indexed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
        [it.id, it.bytes, it.tokens, it.tokenizer, it.lines, gz, it.created_at, Date.now()],
      );
      newItems += r.changes;
    }
    db.run(
      "INSERT INTO sessions (id, agent, worktree, started_at, last_seen_at, ended_at, epoch, epoch_at, cleared_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        b.session.agent,
        worktree,
        b.session.started_at,
        b.session.last_seen_at,
        b.session.ended_at,
        b.session.epoch,
        b.session.epoch_at,
        b.session.cleared_seq,
      ],
    );
    for (const r of b.log)
      db.run(
        "INSERT INTO session_log (session_id, seq, kind, context, worktree, summary, key, files, detail_archive_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          id,
          r.seq,
          r.kind,
          r.context,
          worktree,
          r.summary,
          r.key,
          r.files,
          r.detail_archive_id,
          r.created_at,
        ],
      );
    if (b.stateBlock)
      db.run("INSERT INTO state_blocks (session_id, upto_seq, body, built_at) VALUES (?, ?, ?, ?)", [
        id,
        b.stateBlock.upto_seq,
        b.stateBlock.body,
        b.stateBlock.built_at,
      ]);
    // Decisions that were already replaced are history in the bundle and stay out; the standing ones
    // come in, and a newer local decision on the same topic is left as the current one.
    for (const d of b.decisions.filter((x) => !x.superseded)) {
      const newer = db
        .query(
          "SELECT 1 FROM decisions WHERE worktree = ? AND topic = ? AND superseded_by IS NULL AND created_at > ?",
        )
        .get(worktree, d.topic, d.created_at);
      db.run(
        "INSERT INTO decisions (worktree, topic, label, text, session_id, seq, created_at, superseded_by) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
        [worktree, d.topic, d.label, d.text, id, d.seq, d.created_at],
      );
      if (newer) {
        const row = db.query("SELECT last_insert_rowid() AS id").get() as { id: number };
        const cur = db
          .query(
            "SELECT id FROM decisions WHERE worktree = ? AND topic = ? AND superseded_by IS NULL AND created_at > ? ORDER BY created_at DESC LIMIT 1",
          )
          .get(worktree, d.topic, d.created_at) as { id: number };
        db.run("UPDATE decisions SET superseded_by = ? WHERE id = ?", [cur.id, row.id]);
      }
    }
    for (const s of b.sightings)
      db.run(
        "INSERT INTO sightings (archive_id, session_id, worktree, agent, source_kind, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [s.archive_id, id, worktree, s.agent, s.source_kind, s.source, s.created_at],
      );
  })();
  // make the imported output searchable
  for (const it of b.archive) {
    for (let i = 0; i < 1000 && !store.indexStep(it.id, 1_000_000).done; i++);
  }
  return { sessionId: id, rows: b.log.length, items: b.archive.length, newItems };
}

/** gzip JSON for a file. */
export const packBundle = (b: unknown): Buffer => gzipSync(Buffer.from(JSON.stringify(b)));
export const unpackBundle = (data: Uint8Array): unknown =>
  JSON.parse(gunzipSync(Buffer.from(data)).toString("utf8"));

// ------------------------------------------------------------------ project identity across machines

/** `github.com/owner/repo` from a git remote URL in any common spelling; null if it is not a URL we understand. */
export function normaliseRemote(url: string): string | null {
  const u = url.trim();
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?[/:](.+?)(?:\.git)?\/?$/i.exec(u);
  if (!m) return null;
  const host = m[1]!.toLowerCase();
  const path = m[2]!.replace(/^\/+/, "");
  if (!path.includes("/") && !host.includes(".")) return null;
  return `${host}/${path}`.replace(/\/+$/, "");
}

/** The repo's origin remote, read from `.git/config` without running git. */
export function remoteOf(root: string): string | null {
  const cfg = join(root, ".git", "config");
  if (!existsSync(cfg)) return null;
  try {
    const m = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(readFileSync(cfg, "utf8"));
    return m ? normaliseRemote(m[1]!) : null;
  } catch {
    return null;
  }
}

export const hash8 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex").slice(0, 8);
