import { readFileSync, writeFileSync } from "node:fs";
import {
  deriveKey,
  exportSession,
  importSession,
  isSealed,
  newSalt,
  ProjectStore,
  packBundle,
  paths,
  remoteOf,
  resolveProject,
  seal,
  unpackBundle,
  unseal,
} from "@sieve/core";
import { flag, has } from "./args.ts";

/** `sieve session list | export | import` (slice 11). */

/**
 * Passphrase from the environment or a file, never from the command line (which lands in shell
 * history and process listings).
 */
export function passphraseFrom(args: string[], envName: string): string | undefined {
  const file = flag(args, "--passphrase-file");
  if (file) return readFileSync(file, "utf8").replace(/\r?\n$/, "");
  return process.env[envName] || undefined;
}

// An encrypted bundle: 16-byte salt, then the sealed gzip JSON.
export function sealBundle(packed: Buffer, passphrase: string): Buffer {
  const salt = newSalt();
  return Buffer.concat([salt, seal(packed, deriveKey(passphrase, salt))]);
}
export function openBundle(file: Buffer, passphrase: string): Buffer {
  return unseal(file.subarray(16), deriveKey(passphrase, file.subarray(0, 16)));
}

export function sessionCommand(args: string[], cwd = process.cwd()): number {
  const sub = args.shift();
  const ref = resolveProject(cwd);
  const store = new ProjectStore(ref, paths.projectDb(ref.key));
  try {
    switch (sub) {
      case "list": {
        const rows = store.db
          .query(
            "SELECT s.id, s.agent, s.started_at AS at, s.ended_at AS ended, (SELECT COUNT(*) FROM session_log l WHERE l.session_id = s.id) AS rows FROM sessions s ORDER BY s.last_seen_at DESC LIMIT 30",
          )
          .all() as Array<{ id: string; agent: string; at: number; ended: number | null; rows: number }>;
        if (!rows.length) console.log("No sessions recorded for this project.");
        for (const r of rows)
          console.log(
            `${r.id}  ${r.agent}  ${new Date(r.at).toISOString().slice(0, 16).replace("T", " ")}  ${r.rows} log row(s)${r.ended ? "" : "  (open)"}`,
          );
        return 0;
      }
      case "export": {
        const out = flag(args, "--output") ?? flag(args, "-o");
        const encrypt = has(args, "--encrypt");
        const pass = encrypt ? passphraseFrom(args, "SIEVE_PASSPHRASE") : undefined;
        if (encrypt && !pass) {
          console.error("--encrypt needs a passphrase: set SIEVE_PASSPHRASE or use --passphrase-file <file>");
          return 2;
        }
        const id = args[0] ?? (store.currentSession(ref.worktree) as string | null);
        if (!id) {
          console.error(
            "usage: sieve session export [<session-id>] [-o file] [--encrypt]   (see: sieve session list)",
          );
          return 2;
        }
        const { bundle, skipped } = exportSession(store, id, { remote: remoteOf(ref.root) });
        let data = packBundle(bundle);
        if (pass) data = sealBundle(data, pass);
        const file = out || `${id.replace(/[^\w.-]/g, "_")}.sieve-session${pass ? ".enc" : ".json.gz"}`;
        writeFileSync(file, data, { mode: 0o600 });
        console.log(
          `Wrote ${file}: ${bundle.log.length} log row(s), ${bundle.archive.length} archived item(s)${skipped ? `, ${skipped} too large to include` : ""}${pass ? ", encrypted" : ""}.`,
        );
        if (!pass)
          console.log(
            "Not encrypted. Secrets are already masked in it, but it holds your project's code and command output: treat it like the project (or add --encrypt).",
          );
        return 0;
      }
      case "import": {
        const as = flag(args, "--as");
        const file = args[0];
        if (!file) {
          console.error("usage: sieve session import <file> [--as <new-id>] [--passphrase-file <file>]");
          return 2;
        }
        let data: Buffer = Buffer.from(readFileSync(file));
        if (data.subarray(16, 22).toString() === "SIEVE1" || isSealed(data)) {
          const pass = passphraseFrom(args, "SIEVE_PASSPHRASE");
          if (!pass) {
            console.error("This bundle is encrypted: set SIEVE_PASSPHRASE or use --passphrase-file <file>");
            return 2;
          }
          data = openBundle(data, pass);
        }
        const r = importSession(store, ref.worktree, unpackBundle(data), as ? { as } : {});
        console.log(
          `Imported session ${r.sessionId}: ${r.rows} log row(s), ${r.items} archived item(s) (${r.newItems} new). Ask the agent to call sieve_resume, or: sieve search <words>.`,
        );
        return 0;
      }
      default:
        console.error(
          "usage: sieve session list | export [<id>] [-o file] [--encrypt] | import <file> [--as id]",
        );
        return sub ? 2 : 0;
    }
  } catch (e) {
    console.error((e as Error).message.split("\n")[0]);
    return 1;
  } finally {
    store.db.close();
  }
}
