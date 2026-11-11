import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { type FactRow, norm } from "./memory.ts";
import { paths } from "./paths.ts";
import { deriveKey, newSalt, open, seal } from "./seal.ts";
import { type GlobalStore, ProjectStore } from "./store.ts";
import { exportSession, hash8, importSession, packBundle, remoteOf, unpackBundle } from "./transfer.ts";

/**
 * Encrypted sync (slice 11): memory facts and finished sessions, as encrypted files in a folder
 * you choose (Dropbox, iCloud Drive, Syncthing, a git repository...). Sieve itself makes no network
 * call; whatever syncs the folder does. Files are sealed with a key derived from a passphrase that
 * is never written down, so the folder's host sees only ciphertext and file names.
 *
 *   <dir>/sieve-sync/key.json              salt + a sealed check value (wrong passphrase is caught early)
 *   <dir>/sieve-sync/memory-<machine>.sieve   that machine's facts (each machine writes only its own file)
 *   <dir>/sieve-sync/session-<id>-<machine>.sieve   one finished session, written once
 *
 * Because each machine only ever writes its own files, two machines never write the same file and a
 * file-sync tool has nothing to conflict on. Repos are matched across machines by their git remote.
 */

const KeyFile = z.object({ v: z.literal(1), salt: z.string(), check: z.string() }).strict();
const CHECK = Buffer.from("sieve-sync-ok");

const MemoryBundle = z
  .object({
    format: z.literal("sieve-memory-v1"),
    facts: z
      .array(
        z
          .object({
            subject: z.string().max(300),
            predicate: z.string().max(100),
            object: z.string().max(1000),
            scope: z.enum(["everywhere", "repo"]),
            /** normalised git remote for repo-scoped facts, null for everywhere */
            ref: z.string().max(300).nullable(),
            trust: z.enum(["asserted", "observed", "inferred"]),
            writer: z.string().max(40),
            valid_at: z.number().int().nullable(),
            invalid_at: z.number().int().nullable(),
            created_at: z.number().int(),
            expired_at: z.number().int().nullable(),
            files: z.string().max(2000).nullable(),
          })
          .strict(),
      )
      .max(100_000),
  })
  .strict();

export interface SyncFolderReport {
  pushedFacts: number;
  skippedFacts: number;
  pushedSessions: number;
  pulledFacts: number;
  closedFacts: number;
  pulledSessions: number;
  skippedSessions: string[];
  unreadable: string[];
  notes: string[];
}
const blank = (): SyncFolderReport => ({
  pushedFacts: 0,
  skippedFacts: 0,
  pushedSessions: 0,
  pulledFacts: 0,
  closedFacts: 0,
  pulledSessions: 0,
  skippedSessions: [],
  unreadable: [],
  notes: [],
});

const atomic = (file: string, data: Buffer | string) => {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
};

export class SyncFolder {
  readonly root: string;
  private constructor(
    dir: string,
    private readonly key: Buffer,
    readonly machine: string,
  ) {
    this.root = join(dir, "sieve-sync");
  }

  /** Create the folder's key file (first machine), or open it with the passphrase (any machine). */
  static open(dir: string, passphrase: string, machine: string, create = false): SyncFolder {
    const root = join(dir, "sieve-sync");
    const kf = join(root, "key.json");
    if (!existsSync(kf)) {
      if (!create) throw new Error(`${dir} is not a Sieve sync folder yet (run: sieve sync init ${dir})`);
      mkdirSync(root, { recursive: true });
      const salt = newSalt();
      const key = deriveKey(passphrase, salt);
      atomic(
        kf,
        `${JSON.stringify({ v: 1, salt: salt.toString("base64"), check: seal(CHECK, key).toString("base64") })}\n`,
      );
      return new SyncFolder(dir, key, machine);
    }
    const f = KeyFile.parse(JSON.parse(readFileSync(kf, "utf8")));
    const key = deriveKey(passphrase, Buffer.from(f.salt, "base64"));
    try {
      if (!open(Buffer.from(f.check, "base64"), key).equals(CHECK)) throw new Error();
    } catch {
      throw new Error("wrong passphrase for this sync folder");
    }
    return new SyncFolder(dir, key, machine);
  }

  private write(name: string, data: unknown): void {
    mkdirSync(this.root, { recursive: true });
    atomic(join(this.root, name), seal(packBundle(data), this.key));
  }

  private files(prefix: string): string[] {
    return existsSync(this.root)
      ? readdirSync(this.root)
          .filter((f) => f.startsWith(prefix) && f.endsWith(".sieve"))
          .sort()
      : [];
  }

  private read(name: string): unknown {
    return unpackBundle(open(readFileSync(join(this.root, name)), this.key));
  }

  // ---------------------------------------------------------------- push

  push(gs: GlobalStore, now = Date.now(), opts: { sessionIdleMs?: number } = {}): SyncFolderReport {
    const rep = blank();
    const projects = gs.db.query("SELECT key, root, name FROM projects").all() as Array<{
      key: string;
      root: string;
      name: string;
    }>;
    const remoteByKey = new Map(projects.map((p) => [p.key, remoteOf(p.root)]));

    const rows = gs.db.query("SELECT * FROM facts ORDER BY id").all() as FactRow[];
    const facts: z.infer<typeof MemoryBundle>["facts"] = [];
    for (const r of rows) {
      if (r.scope === "everywhere") {
        facts.push(pick(r, "everywhere", null));
      } else if (r.scope === "repo") {
        const remote = r.scope_ref ? (remoteByKey.get(r.scope_ref) ?? null) : null;
        if (!remote) {
          rep.skippedFacts++;
          continue;
        }
        facts.push(pick(r, "repo", remote));
      } else rep.skippedFacts++; // project and worktree facts describe this machine's checkout
    }
    this.write(`memory-${this.machine}.sieve`, { format: "sieve-memory-v1", facts });
    rep.pushedFacts = facts.length;
    if (rep.skippedFacts)
      rep.notes.push(
        `${rep.skippedFacts} fact(s) stayed local (project/worktree scope, or a repo with no git remote)`,
      );

    // finished sessions, once each
    const idle = opts.sessionIdleMs ?? 3600_000;
    for (const p of projects) {
      const dbFile = paths.projectDb(p.key);
      if (!existsSync(dbFile)) continue;
      const remote = remoteByKey.get(p.key) ?? null;
      if (!remote) continue;
      const store = new ProjectStore({ key: p.key, root: p.root, name: p.name, worktree: p.root });
      try {
        const sessions = store.db.query("SELECT id, ended_at, last_seen_at FROM sessions").all() as Array<{
          id: string;
          ended_at: number | null;
          last_seen_at: number;
        }>;
        for (const s of sessions) {
          if (!s.ended_at && now - s.last_seen_at < idle) continue; // still live
          const name = `session-${hash8(s.id + remote)}-${this.machine}.sieve`;
          if (existsSync(join(this.root, name))) continue;
          this.write(name, exportSession(store, s.id, { remote, now }).bundle);
          rep.pushedSessions++;
        }
      } finally {
        store.db.close();
      }
    }
    return rep;
  }

  // ---------------------------------------------------------------- pull

  pull(gs: GlobalStore, now = Date.now()): SyncFolderReport {
    const rep = blank();
    const projects = gs.db.query("SELECT key, root, name FROM projects").all() as Array<{
      key: string;
      root: string;
      name: string;
    }>;
    const keyByRemote = new Map<string, (typeof projects)[number]>();
    for (const p of projects) {
      const r = remoteOf(p.root);
      if (r) keyByRemote.set(r, p);
    }

    for (const name of this.files("memory-")) {
      if (name === `memory-${this.machine}.sieve`) continue;
      let bundle: z.infer<typeof MemoryBundle>;
      try {
        bundle = MemoryBundle.parse(this.read(name));
      } catch (e) {
        rep.unreadable.push(`${name}: ${(e as Error).message}`);
        continue;
      }
      let missing = 0;
      gs.db.transaction(() => {
        for (const f of bundle.facts) {
          let ref: string | null = null;
          if (f.scope === "repo") {
            const p = keyByRemote.get(f.ref ?? "");
            if (!p) {
              missing++;
              continue;
            }
            ref = p.key;
          }
          const same = (
            gs.db
              .query(
                "SELECT id, expired_at, invalid_at, subject, object FROM facts WHERE scope = ? AND IFNULL(scope_ref, '') = ? AND predicate = ? AND IFNULL(valid_at, -1) = ?",
              )
              .all(f.scope, ref ?? "", f.predicate, f.valid_at ?? -1) as Array<{
              id: number;
              expired_at: number | null;
              invalid_at: number | null;
              subject: string;
              object: string;
            }>
          ).find((r) => norm(r.subject) === norm(f.subject) && norm(r.object) === norm(f.object));
          if (!same) {
            gs.db.run(
              `INSERT INTO facts (subject, predicate, object, scope, scope_ref, trust, writer, valid_at, invalid_at, created_at, expired_at, files)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                f.subject,
                f.predicate,
                f.object,
                f.scope,
                ref,
                f.trust,
                "sync",
                f.valid_at,
                f.invalid_at,
                f.created_at,
                f.expired_at,
                f.files,
              ],
            );
            rep.pulledFacts++;
          } else if (same.expired_at === null && f.expired_at !== null) {
            // the other machine closed it: the closure travels
            gs.db.run("UPDATE facts SET invalid_at = ?, expired_at = ? WHERE id = ?", [
              f.invalid_at ?? f.expired_at,
              f.expired_at,
              same.id,
            ]);
            rep.closedFacts++;
          }
        }
      })();
      if (missing)
        rep.notes.push(
          `${name}: ${missing} fact(s) are for repos not cloned on this machine (clone, run sieve once there, pull again)`,
        );
    }

    for (const name of this.files("session-")) {
      if (name.endsWith(`-${this.machine}.sieve`)) continue;
      let raw: unknown;
      try {
        raw = this.read(name);
      } catch (e) {
        rep.unreadable.push(`${name}: ${(e as Error).message}`);
        continue;
      }
      const remote = (raw as { remote?: string | null })?.remote ?? null;
      const p = remote ? keyByRemote.get(remote) : undefined;
      if (!p) {
        rep.skippedSessions.push(`${name}: repo ${remote ?? "(none)"} is not known on this machine`);
        continue;
      }
      const store = new ProjectStore({ key: p.key, root: p.root, name: p.name, worktree: p.root });
      try {
        const id = (raw as { session?: { id?: string } }).session?.id;
        if (id && store.db.query("SELECT 1 FROM sessions WHERE id = ?").get(id)) continue; // already here
        importSession(store, p.root, raw);
        rep.pulledSessions++;
      } catch (e) {
        rep.unreadable.push(`${name}: ${(e as Error).message}`);
      } finally {
        store.db.close();
      }
    }
    void now;
    return rep;
  }
}

function pick(
  r: FactRow,
  scope: "everywhere" | "repo",
  ref: string | null,
): z.infer<typeof MemoryBundle>["facts"][number] {
  return {
    subject: r.subject,
    predicate: r.predicate,
    object: r.object,
    scope,
    ref,
    trust: r.trust,
    writer: r.writer,
    valid_at: r.valid_at,
    invalid_at: r.invalid_at,
    created_at: r.created_at,
    expired_at: r.expired_at,
    files: r.files ?? null,
  };
}

/** A random id for this machine in sync file names. */
export const newMachineId = () => randomBytes(4).toString("hex");
