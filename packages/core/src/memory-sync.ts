import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Fact, type Memory, norm, type Where } from "./memory.ts";

/**
 * `sieve memory sync`: a repo's facts as Markdown files in `.sieve/memory/`, one fact per file,
 * so people can read them, edit them and commit them, and git history is the audit trail.
 *
 * Only facts scoped to the repo are written. Everything read back is capped at "observed" and
 * labelled as written by Markdown, because a file arriving in a pull request is not the user's
 * own words: it can inform a session but never reaches the asserted-only core block.
 */

const MAX_FILE = 8 * 1024;
const MANIFEST = ".sync.json";

export interface SyncReport {
  wrote: string[];
  removed: string[];
  imported: string[];
  changed: string[];
  retracted: string[];
  skipped: string[];
}

/** A key that follows a fact's content, so teammates' databases agree on which file is which fact. */
export function factKey(subject: string, predicate: string, object: string): string {
  return createHash("sha256")
    .update(`${norm(subject)}|${predicate}|${norm(object)}`)
    .digest("hex")
    .slice(0, 16);
}

const slug = (s: string) =>
  norm(s)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "fact";

export function fileNameFor(f: Pick<Fact, "subject" | "predicate" | "object">): string {
  return `${slug(f.subject)}--${slug(f.predicate)}--${factKey(f.subject, f.predicate, f.object).slice(0, 6)}.md`;
}

export function renderFact(f: Fact): string {
  const head = [
    ["key", factKey(f.subject, f.predicate, f.object)],
    ["subject", f.subject],
    ["predicate", f.predicate],
    ["scope", f.scope],
    ["trust", f.trust],
    ["valid_at", new Date(f.validAt ?? f.createdAt).toISOString()],
  ]
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `---\n${head}\n---\n${f.object}\n`;
}

export interface Parsed {
  meta: Record<string, string>;
  body: string;
}

export function parseFactFile(text: string): Parsed | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const l of m[1]!.split(/\r?\n/)) {
    const i = l.indexOf(":");
    if (i < 1) continue;
    const k = l.slice(0, i).trim();
    const raw = l.slice(i + 1).trim();
    let v = raw;
    if (raw.startsWith('"')) {
      try {
        v = String(JSON.parse(raw));
      } catch {
        v = raw.slice(1, -1);
      }
    }
    meta[k] = v;
  }
  return { meta, body: m[2]!.trim() };
}

export function syncMemory(
  memory: Memory,
  where: Where,
  dir: string,
  now: number,
  opts: { dryRun?: boolean } = {},
): SyncReport {
  const rep: SyncReport = { wrote: [], removed: [], imported: [], changed: [], retracted: [], skipped: [] };
  const dry = opts.dryRun === true;
  if (!dry) mkdirSync(dir, { recursive: true });

  let manifest: string[] = [];
  try {
    const raw = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"));
    if (Array.isArray(raw.keys))
      manifest = raw.keys.filter((k: unknown): k is string => typeof k === "string");
  } catch {}

  const repoFacts = () => memory.active(where).filter((f) => f.scope === "repo" && f.scopeRef === where.key);
  const byKey = () => new Map(repoFacts().map((f) => [factKey(f.subject, f.predicate, f.object), f]));

  // ---- read what is on disk (direct children only, size-capped)
  const files = new Map<string, Parsed>();
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".md")) continue;
      const p = join(dir, name);
      try {
        const st = statSync(p);
        if (!st.isFile()) continue;
        if (st.size > MAX_FILE) {
          rep.skipped.push(`${name}: over ${MAX_FILE / 1024} KB`);
          continue;
        }
        const parsed = parseFactFile(readFileSync(p, "utf8"));
        if (!parsed) rep.skipped.push(`${name}: no front matter`);
        else files.set(name, parsed);
      } catch (e) {
        rep.skipped.push(`${name}: ${(e as Error).message}`);
      }
    }
  }

  // ---- 1. files → database
  const current = byKey();
  const seenKeys = new Set<string>();
  for (const [name, { meta, body }] of files) {
    const subject = meta.subject ?? "";
    const predicate = meta.predicate ?? "";
    if (!subject || !predicate || !body) {
      rep.skipped.push(`${name}: needs subject, predicate and a value`);
      continue;
    }
    if ((meta.scope ?? "repo") !== "repo") {
      rep.skipped.push(`${name}: only repo-scoped facts are synced`);
      continue;
    }
    const key = meta.key;
    if (key) seenKeys.add(key);
    const matches = key !== undefined && key === factKey(subject, predicate, body);
    const live = key ? current.get(key) : undefined;
    if (key && matches) {
      if (live) continue; // unchanged
      const retiredHere = memory
        .history(where, subject, predicate)
        .some(
          (h) =>
            h.expiredAt !== null && h.scope === "repo" && factKey(h.subject, h.predicate, h.object) === key,
        );
      if (retiredHere) {
        // unchanged since export, and this database has retired the fact: the file is stale
        if (!dry) unlinkSync(join(dir, name));
        rep.removed.push(name);
        continue;
      }
    }
    // new file, or an edited one (its key no longer matches its content)
    if (live && key) {
      if (!dry) memory.retractId(live.id, now);
      rep.changed.push(name);
    }
    if (dry) {
      (live ? rep.changed : rep.imported).push(name);
      continue;
    }
    const r = memory.remember(
      { subject, predicate, object: body, scope: "repo", writer: "markdown", at: now },
      where,
    );
    if (r.status === "refused") rep.skipped.push(`${name}: ${r.reason}`);
    else {
      if (!live) rep.imported.push(name);
      // The file is replaced by the canonical one for the fact it became (written below).
      unlinkSync(join(dir, name));
    }
  }

  // ---- 2. a file that was exported and is now gone was deleted on purpose: retract the fact
  const present = new Set([...files.values()].map((f) => f.meta.key).filter((k): k is string => !!k));
  for (const key of manifest) {
    if (present.has(key)) continue;
    const f = current.get(key);
    if (!f) continue;
    if (!dry) memory.retractId(f.id, now);
    rep.retracted.push(`${f.subject} ${f.predicate}: ${f.object}`);
  }

  // ---- 3. database → files
  const final = new Map<string, Fact>(repoFacts().map((f) => [factKey(f.subject, f.predicate, f.object), f]));
  const onDisk = new Set(
    [...files.values()].map((f) => f.meta.key).filter((k): k is string => !!k && final.has(k)),
  );
  const keys: string[] = [];
  for (const [key, f] of final) {
    keys.push(key);
    if (onDisk.has(key)) continue;
    const name = fileNameFor(f);
    if (!dry) writeFileSync(join(dir, name), renderFact(f));
    rep.wrote.push(name);
  }
  if (!dry) writeFileSync(join(dir, MANIFEST), `${JSON.stringify({ keys: keys.sort() }, null, 2)}\n`);
  return rep;
}
