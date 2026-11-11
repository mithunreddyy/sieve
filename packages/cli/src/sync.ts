import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GlobalStore, newMachineId, paths, SyncFolder } from "@sieve/core";
import { has } from "./args.ts";
import { passphraseFrom } from "./session.ts";

/** `sieve sync init <dir> | push | pull | status` (slice 11). Encrypted files in a folder you sync yourself. */

const cfgFile = () => join(paths.home(), "sync.json");
const load = (): { dir: string; machine: string } | null => {
  try {
    const j = JSON.parse(readFileSync(cfgFile(), "utf8"));
    return typeof j.dir === "string" && typeof j.machine === "string" ? j : null;
  } catch {
    return null;
  }
};

export function syncCommand(args: string[]): number {
  const sub = args.shift();
  const quiet = has(args, "--quiet");
  void quiet;
  try {
    if (sub === "init") {
      const dir = args[0] ? resolve(args[0]) : null;
      const pass = passphraseFrom(args, "SIEVE_SYNC_PASSPHRASE");
      if (!dir || !pass) {
        console.error(
          "usage: SIEVE_SYNC_PASSPHRASE=… sieve sync init <folder>   (or --passphrase-file <file>; at least 8 characters)",
        );
        return 2;
      }
      const machine = load()?.machine ?? newMachineId();
      mkdirSync(dir, { recursive: true });
      SyncFolder.open(dir, pass, machine, true);
      mkdirSync(dirname(cfgFile()), { recursive: true });
      writeFileSync(cfgFile(), `${JSON.stringify({ dir, machine }, null, 2)}\n`, { mode: 0o600 });
      console.log(`Sync folder ready: ${dir}/sieve-sync (this machine: ${machine}).`);
      console.log(
        "The passphrase is not stored anywhere; give the same one on every machine. On another machine run: sieve sync init <the same folder>",
      );
      console.log(
        "Sieve makes no network call: whatever syncs that folder (Dropbox, iCloud Drive, Syncthing, git) does. Only encrypted files are written to it.",
      );
      return 0;
    }
    const cfg = load();
    if (!cfg) {
      console.error("Sync is not set up. Run: SIEVE_SYNC_PASSPHRASE=… sieve sync init <folder>");
      return 1;
    }
    if (sub === "status") {
      console.log(
        `folder ${cfg.dir}/sieve-sync · machine ${cfg.machine} · ${existsSync(join(cfg.dir, "sieve-sync", "key.json")) ? "key file present" : "key file MISSING"}`,
      );
      return 0;
    }
    if (sub !== "push" && sub !== "pull") {
      console.error("usage: sieve sync init <folder> | push | pull | status");
      return sub ? 2 : 0;
    }
    const pass = passphraseFrom(args, "SIEVE_SYNC_PASSPHRASE");
    if (!pass) {
      console.error("Set SIEVE_SYNC_PASSPHRASE or use --passphrase-file <file>");
      return 2;
    }
    const folder = SyncFolder.open(cfg.dir, pass, cfg.machine);
    const gs = new GlobalStore(paths.globalDb());
    try {
      const r = sub === "push" ? folder.push(gs) : folder.pull(gs);
      if (sub === "push")
        console.log(`Pushed ${r.pushedFacts} fact(s) and ${r.pushedSessions} new finished session(s).`);
      else
        console.log(
          `Pulled ${r.pulledFacts} new fact(s), closed ${r.closedFacts}, imported ${r.pulledSessions} session(s).`,
        );
      for (const n of r.notes) console.log(`note: ${n}`);
      for (const s of r.skippedSessions) console.log(`skipped ${s}`);
      for (const u of r.unreadable) console.log(`UNREADABLE ${u}`);
      return r.unreadable.length ? 1 : 0;
    } finally {
      gs.close();
    }
  } catch (e) {
    console.error((e as Error).message.split("\n")[0]);
    return 1;
  }
}
