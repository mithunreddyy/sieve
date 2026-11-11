import { join } from "node:path";
import { type Fact, formatFact, GlobalStore, paths, resolveProject, syncMemory } from "@sieve/core";

/** `sieve memory list | review | sync | edit | prune` (slice 8). Works on the same database as the daemon. */

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, v === undefined || v.startsWith("--") ? 1 : 2);
  return v === undefined || v.startsWith("--") ? "" : v;
};
const has = (args: string[], name: string) => {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
};

const day = (ms: number | null) => (ms === null ? "—" : new Date(ms).toISOString().slice(0, 10));
const fact = (f: Fact) =>
  `#${f.id} ${formatFact(f)}  [${f.scope}, ${f.trust}${f.writer === "user" ? "" : `, by ${f.writer}`}, ${day(f.validAt ?? f.createdAt)}${f.uses ? `, used ${f.uses}×` : ""}]`;

export function memoryCommand(args: string[], cwd = process.cwd()): number {
  const sub = args.shift();
  const gs = new GlobalStore(paths.globalDb());
  try {
    const ref = resolveProject(cwd);
    const where = { key: ref.key, root: ref.root, worktree: ref.worktree };
    const m = gs.memory;
    switch (sub) {
      case "list": {
        const history = has(args, "--history");
        const json = has(args, "--json");
        const subject = args[0];
        const facts = history && subject ? m.history(where, subject) : m.active(where);
        const shown =
          subject && !history
            ? facts.filter((f) => f.subject.toLowerCase().includes(subject.toLowerCase()))
            : facts;
        if (json) console.log(JSON.stringify(shown, null, 2));
        else if (!shown.length) console.log("No stored facts here.");
        else
          for (const f of shown)
            console.log(
              history ? `${fact(f)}${f.expiredAt ? `  (closed ${day(f.expiredAt)})` : ""}` : fact(f),
            );
        return 0;
      }
      case "review": {
        const r = m.review(where);
        let any = false;
        if (r.duplicates.length) {
          any = true;
          console.log("Possible duplicates (retract one with `sieve memory edit <id> --retract`):");
          for (const d of r.duplicates) {
            console.log(`  ${d.reason}`);
            for (const f of d.facts) console.log(`    ${fact(f)}`);
          }
        }
        if (r.newPredicates.length) {
          any = true;
          console.log("Predicates outside the vocabulary (each may be a spelling of one that exists):");
          for (const p of r.newPredicates)
            console.log(`  ${p.predicate} (${p.count})${p.closeTo ? `  — close to ${p.closeTo}` : ""}`);
        }
        if (r.unconfirmed.length) {
          any = true;
          console.log(
            `Not asserted by you (${r.unconfirmed.length}); these never enter the always-on block:`,
          );
          for (const f of r.unconfirmed) console.log(`  ${fact(f)}`);
        }
        if (!any) console.log("Nothing to review.");
        return 0;
      }
      case "sync": {
        const dry = has(args, "--dry-run");
        const dir = join(ref.root, ".sieve", "memory");
        const r = syncMemory(m, where, dir, Date.now(), { dryRun: dry });
        const label = dry ? "would " : "";
        const out = (what: string, xs: string[]) => {
          if (xs.length) console.log(`${label}${what} ${xs.length}: ${xs.join(", ")}`);
        };
        out("write", r.wrote);
        out("remove stale", r.removed);
        out("import", r.imported);
        out("update from edited files", r.changed);
        out("retract (file deleted)", r.retracted);
        for (const s of r.skipped) console.log(`skipped ${s}`);
        if (!Object.values(r).some((x) => x.length)) console.log(`Already in sync (${dir}).`);
        else if (!dry)
          console.log(`Memory files are in ${dir}. Commit them to share; git history is the audit trail.`);
        return 0;
      }
      case "edit": {
        const id = Number(args.shift());
        if (!Number.isInteger(id)) {
          console.error('usage: sieve memory edit <id> --object "new value" | --retract');
          return 2;
        }
        const f = m.get(id);
        if (!f) {
          console.error(`no fact #${id}`);
          return 1;
        }
        if (f.expiredAt !== null) {
          console.error(`#${id} is already closed (${day(f.expiredAt)}); it stays in the history`);
          return 1;
        }
        const now = Date.now();
        if (has(args, "--retract")) {
          m.retractId(id, now);
          console.log(`Retracted #${id}: ${formatFact(f)} (kept in the history).`);
          return 0;
        }
        const object = flag(args, "--object");
        if (!object) {
          console.error('usage: sieve memory edit <id> --object "new value" | --retract');
          return 2;
        }
        // The user is the writer, so the edit is asserted. The old row is closed, not rewritten;
        // a refused value (a credential) changes nothing.
        const r = m.remember(
          { subject: f.subject, predicate: f.predicate, object, scope: f.scope, writer: "user", at: now },
          where,
        );
        if (r.status === "refused") {
          console.error(`Not changed: ${r.reason}`);
          return 1;
        }
        m.retractId(id, now); // a no-op when a single-valued predicate already closed it
        console.log(`#${id} replaced: ${object}`);
        return 0;
      }
      case "prune": {
        const days = Number(flag(args, "--days") ?? 90);
        const yes = has(args, "--yes");
        if (!Number.isFinite(days) || days < 0) {
          console.error("usage: sieve memory prune [--days 90] [--yes]");
          return 2;
        }
        const before = Date.now() - days * 86_400_000;
        const n = gs.db
          .query("SELECT COUNT(*) AS n FROM facts WHERE expired_at IS NOT NULL AND expired_at < ?")
          .get(before) as { n: number };
        if (!yes) {
          console.log(
            `${n.n} closed fact(s) older than ${days} days would be deleted for good. Active facts are never touched. Re-run with --yes.`,
          );
          return 0;
        }
        console.log(`Deleted ${m.prune(before)} closed fact(s).`);
        return 0;
      }
      default:
        console.error(
          "usage: sieve memory list [subject] [--history] [--json] | review | sync [--dry-run] | edit <id> (--object v | --retract) | prune [--days 90] [--yes]",
        );
        return sub ? 2 : 0;
    }
  } finally {
    gs.close();
  }
}

export function memoryStatusLine(): string {
  const gs = new GlobalStore(paths.globalDb());
  try {
    const c = gs.memory.counts();
    return `${c.active} active fact(s), ${c.closed} closed (kept as history)`;
  } finally {
    gs.close();
  }
}
