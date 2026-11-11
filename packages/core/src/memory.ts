import type { Database } from "bun:sqlite";
import { maskSecrets } from "./secrets.ts";

/**
 * Long-term memory (slice 8): subject–predicate–object facts with two timelines.
 *
 *   valid_at / invalid_at   when the fact was true in the world
 *   created_at / expired_at when Sieve recorded it, and when it stopped believing it
 *
 * Nothing is deleted when a fact is replaced or retracted: the old row is closed, so "what did
 * we believe last month" stays answerable. `prune` is the only thing that deletes, and only on
 * the user's command.
 *
 * Everything here is deterministic. No model is involved in writing, resolving or ranking.
 */

export type Scope = "everywhere" | "repo" | "project" | "worktree";
export type Trust = "asserted" | "observed" | "inferred";
/** Who is writing: it caps the trust a fact can claim. */
export type Writer = "user" | "agent" | "rule" | "markdown" | "model";

export const SCOPES: readonly Scope[] = ["everywhere", "repo", "project", "worktree"];
const TRUST_RANK: Record<Trust, number> = { inferred: 0, observed: 1, asserted: 2 };
/** The most trust each kind of writer may claim. An agent's claim of "asserted" must be earned. */
const MAX_TRUST: Record<Writer, Trust> = {
  user: "asserted",
  agent: "observed",
  rule: "observed",
  markdown: "observed",
  model: "inferred",
};
/** Narrower scopes win when two facts disagree. */
const SPECIFICITY: Record<Scope, number> = { everywhere: 0, repo: 1, project: 2, worktree: 3 };

export interface Where {
  /** Repo key shared by every worktree and clone of one repository. */
  key: string;
  /** Root of this checkout (all its worktrees). */
  root: string;
  /** The worktree in use. */
  worktree: string;
}

export interface Fact {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  scope: Scope;
  scopeRef: string | null;
  trust: Trust;
  writer: string;
  validAt: number | null;
  invalidAt: number | null;
  createdAt: number;
  expiredAt: number | null;
  sourceArchiveId: string | null;
  /** Files (relative paths) the value mentions: if one changes after the fact, it may be out of date. */
  files: string[];
  uses: number;
  lastUsedAt: number | null;
}

/** A `facts` table row as SQLite returns it. */
export interface FactRow {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  scope: Scope;
  scope_ref: string | null;
  trust: Trust;
  writer: string;
  valid_at: number | null;
  invalid_at: number | null;
  created_at: number;
  expired_at: number | null;
  source_archive_id: string | null;
  files: string | null;
  uses: number;
  last_used_at: number | null;
}

const toFact = (r: FactRow): Fact => ({
  id: r.id,
  subject: r.subject,
  predicate: r.predicate,
  object: r.object,
  scope: r.scope,
  scopeRef: r.scope_ref,
  trust: r.trust,
  writer: r.writer,
  validAt: r.valid_at,
  invalidAt: r.invalid_at,
  createdAt: r.created_at,
  expiredAt: r.expired_at,
  sourceArchiveId: r.source_archive_id,
  files: r.files ? (JSON.parse(r.files) as string[]) : [],
  uses: r.uses,
  lastUsedAt: r.last_used_at,
});

// ------------------------------------------------------------------ vocabulary

interface Seed {
  canonical: string;
  single: boolean;
  /** Tied to a codebase: such a fact cannot be wider than its repo. */
  codebase: boolean;
  aliases: string[];
}

/**
 * The canonical predicate vocabulary. A new fact's predicate is matched against these and their
 * aliases before anything is inserted, which is what stops "test cmd", "tests are run with" and
 * "test_command" from becoming three slots for one fact.
 */
export const SEED: Seed[] = [
  {
    canonical: "test_command",
    single: true,
    codebase: true,
    aliases: [
      "test cmd",
      "tests run with",
      "run tests with",
      "runs tests with",
      "test script",
      "how to test",
    ],
  },
  {
    canonical: "build_command",
    single: true,
    codebase: true,
    aliases: ["build cmd", "builds with", "build script", "how to build", "compile command"],
  },
  {
    canonical: "lint_command",
    single: true,
    codebase: true,
    aliases: ["lint cmd", "lints with", "linter", "lint script", "format command"],
  },
  {
    canonical: "package_manager",
    single: true,
    codebase: true,
    aliases: ["uses package manager", "package mgr", "pkg manager", "installs with", "uses pm"],
  },
  {
    canonical: "runtime",
    single: true,
    codebase: true,
    aliases: ["runs on", "runtime version", "node version", "python version", "language version"],
  },
  {
    canonical: "language",
    single: false,
    codebase: true,
    aliases: ["written in", "uses language", "languages"],
  },
  {
    canonical: "framework",
    single: false,
    codebase: true,
    aliases: ["uses framework", "built with", "frameworks"],
  },
  {
    canonical: "database",
    single: true,
    codebase: true,
    aliases: ["db", "uses database", "datastore", "uses db"],
  },
  {
    canonical: "deploys_to",
    single: true,
    codebase: true,
    aliases: ["deploy target", "deployed to", "hosting", "hosted on", "deploys on"],
  },
  {
    canonical: "branch_convention",
    single: true,
    codebase: true,
    aliases: ["branch naming", "branch names", "branch name format"],
  },
  {
    canonical: "commit_style",
    single: true,
    codebase: true,
    aliases: ["commit convention", "commit message format", "commit messages", "commit format"],
  },
  {
    canonical: "code_style",
    single: false,
    codebase: true,
    aliases: ["style", "coding style", "conventions", "convention", "code conventions"],
  },
  { canonical: "owner", single: true, codebase: true, aliases: ["owned by", "maintainer", "maintained by"] },
  { canonical: "last_commit", single: true, codebase: true, aliases: ["latest commit", "head commit"] },
  { canonical: "last_pr", single: true, codebase: true, aliases: ["latest pr", "latest pull request"] },
  { canonical: "decision", single: true, codebase: true, aliases: ["decided", "we decided", "decisions"] },
  {
    canonical: "prefers",
    single: false,
    codebase: false,
    aliases: ["likes", "prefer", "preference", "preferences"],
  },
  {
    canonical: "avoids",
    single: false,
    codebase: false,
    aliases: ["dislikes", "avoid", "never uses", "doesnt want"],
  },
  { canonical: "editor", single: true, codebase: false, aliases: ["uses editor", "ide", "uses ide"] },
  { canonical: "shell", single: true, codebase: false, aliases: ["uses shell", "default shell"] },
  { canonical: "role", single: true, codebase: false, aliases: ["works as", "job", "job title"] },
  { canonical: "note", single: false, codebase: false, aliases: ["notes", "remember", "fact", "info"] },
];

// ------------------------------------------------------------------ text helpers

const DAY_MS = 86_400_000;
export const HALF_LIFE_DAYS = 30;

/** Lowercase, separators to single spaces, accents folded. Used only to compare, never to store. */
export function norm(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[_\-./\\]+/g, " ")
    .replace(/[^\p{L}\p{N}\s:@#+]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(the|a|an) /, "");
}

function trigrams(s: string): Set<string> {
  const p = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3));
  return out;
}

/** Dice coefficient over character trigrams, 0..1. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const x = trigrams(a);
  const y = trigrams(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const g of x) if (y.has(g)) n++;
  return (2 * n) / (x.size + y.size);
}

const STOP = new Set(
  "the and for are but not you all can had her was one our out has how its who did get may him his she too use any now see way what when with this that from have will your they been into than then them these some such only over also just like make more most much many very would could should about which there their where while after before because does doing done".split(
    " ",
  ),
);

/** Words worth matching on: 3+ characters, not filler. */
export function terms(text: string): string[] {
  const out = new Set<string>();
  for (const w of norm(text).split(" ")) if (w.length >= 3 && !STOP.has(w)) out.add(w);
  return [...out];
}

// ------------------------------------------------------------------ results

export type RememberResult =
  | { status: "added"; fact: Fact; closed: Fact[]; notes: string[] }
  | { status: "restated"; fact: Fact; notes: string[] }
  | { status: "retracted"; closed: Fact[]; notes: string[] }
  | { status: "kept"; fact: Fact; notes: string[] }
  | { status: "refused"; reason: string; notes: string[] };

export interface RememberInput {
  subject: string;
  predicate: string;
  object: string;
  scope?: Scope;
  retract?: boolean;
  writer: Writer;
  /** Trust the writer asks for; capped by the writer. Default: the writer's maximum. */
  trust?: Trust;
  /** What the user has said in this session; an "asserted" claim from an agent needs the object in here. */
  userWords?: string[];
  sourceArchiveId?: string | null;
  at: number;
}

export interface DuplicateGroup {
  reason: string;
  facts: Fact[];
}

export interface Review {
  duplicates: DuplicateGroup[];
  /** Predicates nobody defined: each may be a spelling of one that exists. */
  newPredicates: Array<{ predicate: string; count: number; closeTo: string | null }>;
  /** Facts that are not asserted, so no core block shows them. */
  unconfirmed: Fact[];
}

const LIMITS = { subject: 120, predicate: 60, object: 500 };

export class Memory {
  constructor(private readonly db: Database) {
    this.seed();
  }

  private seed(): void {
    const have = this.db.query("SELECT COUNT(*) AS n FROM predicates").get() as { n: number };
    if (have.n >= SEED.length) return;
    this.db.transaction(() => {
      for (const s of SEED) {
        this.db.run(
          "INSERT OR IGNORE INTO predicates (canonical, single_valued, codebase) VALUES (?, ?, ?)",
          [s.canonical, s.single ? 1 : 0, s.codebase ? 1 : 0],
        );
        for (const a of s.aliases)
          this.db.run("INSERT OR IGNORE INTO predicate_aliases (alias, canonical) VALUES (?, ?)", [
            norm(a),
            s.canonical,
          ]);
      }
    })();
  }

  // -------------------------------------------------------------- resolution

  /** The canonical form of a predicate, and how it was reached. */
  resolvePredicate(raw: string): { canonical: string; how: "exact" | "alias" | "similar" | "new" } {
    const key = norm(raw).replace(/ /g, "_");
    const spaced = norm(raw);
    const exact = this.db.query("SELECT canonical FROM predicates WHERE canonical = ?").get(key) as {
      canonical: string;
    } | null;
    if (exact) return { canonical: exact.canonical, how: "exact" };
    const alias = this.db.query("SELECT canonical FROM predicate_aliases WHERE alias = ?").get(spaced) as {
      canonical: string;
    } | null;
    if (alias) return { canonical: alias.canonical, how: "alias" };
    let best: { c: string; s: number } | null = null;
    const names = this.db
      .query(
        "SELECT canonical AS c, canonical AS a FROM predicates UNION SELECT canonical, alias FROM predicate_aliases",
      )
      .all() as Array<{ c: string; a: string }>;
    for (const n of names) {
      const s = similarity(spaced, norm(n.a));
      if (s >= 0.72 && (!best || s > best.s)) best = { c: n.c, s };
    }
    if (best) return { canonical: best.c, how: "similar" };
    return { canonical: key, how: "new" };
  }

  private predicateInfo(canonical: string): { single: boolean; codebase: boolean } {
    const r = this.db
      .query("SELECT single_valued AS s, codebase AS c FROM predicates WHERE canonical = ?")
      .get(canonical) as { s: number; c: number } | null;
    return { single: !!r?.s, codebase: !!r?.c };
  }

  /**
   * The spelling of a subject already in use, if one is close enough: "the api server" and
   * "API server" are one subject. Compared within the facts this place can see.
   */
  private resolveSubject(raw: string, where: Where): string {
    const want = norm(raw);
    let best: { s: string; v: number } | null = null;
    for (const r of this.visibleRows(where, true)) {
      const have = norm(r.subject);
      const v = have === want ? 1 : similarity(have, want);
      if (v >= 0.82 && (!best || v > best.v)) best = { s: r.subject, v };
    }
    return best ? best.s : raw.trim();
  }

  // -------------------------------------------------------------- queries

  private scopeRef(scope: Scope, where: Where): string | null {
    return scope === "everywhere"
      ? null
      : scope === "repo"
        ? where.key
        : scope === "project"
          ? where.root
          : where.worktree;
  }

  private visibleRows(where: Where, activeOnly: boolean): FactRow[] {
    const rows = this.db
      .query(
        `SELECT * FROM facts WHERE ${activeOnly ? "expired_at IS NULL AND invalid_at IS NULL AND" : ""}
         (scope = 'everywhere' OR (scope = 'repo' AND scope_ref = ?1)
          OR (scope = 'project' AND scope_ref = ?2) OR (scope = 'worktree' AND scope_ref = ?3))
         ORDER BY id`,
      )
      .all(where.key, where.root, where.worktree) as FactRow[];
    return rows;
  }

  /**
   * What is believed here: active facts visible from this place. Where a single-valued predicate
   * has a value at a narrower scope, that one replaces the wider ones in this view.
   */
  active(where: Where): Fact[] {
    const rows = this.visibleRows(where, true).map(toFact);
    const best = new Map<string, Fact>();
    const out: Fact[] = [];
    for (const f of rows) {
      if (!this.predicateInfo(f.predicate).single) {
        out.push(f);
        continue;
      }
      const k = `${norm(f.subject)}|${f.predicate}`;
      const cur = best.get(k);
      if (!cur || SPECIFICITY[f.scope] > SPECIFICITY[cur.scope] || (f.scope === cur.scope && f.id > cur.id))
        best.set(k, f);
    }
    out.push(...best.values());
    return out.sort((a, b) => a.id - b.id);
  }

  get(id: number): Fact | null {
    const r = this.db.query("SELECT * FROM facts WHERE id = ?").get(id) as FactRow | null;
    return r ? toFact(r) : null;
  }

  /** Every fact ever recorded for a subject and predicate here, newest first (the history). */
  history(where: Where, subject: string, predicate?: string): Fact[] {
    const want = norm(subject);
    const pred = predicate ? this.resolvePredicate(predicate).canonical : null;
    return this.visibleRows(where, false)
      .map(toFact)
      .filter((f) => norm(f.subject) === want && (!pred || f.predicate === pred))
      .sort((a, b) => b.id - a.id);
  }

  // -------------------------------------------------------------- writing

  remember(input: RememberInput, where: Where): RememberResult {
    const notes: string[] = [];
    const subject = input.subject.trim();
    const object = input.object.trim();
    if (!subject || !input.predicate.trim() || !object)
      return { status: "refused", reason: "subject, predicate and object must not be empty", notes };
    if (
      subject.length > LIMITS.subject ||
      input.predicate.length > LIMITS.predicate ||
      object.length > LIMITS.object
    )
      return {
        status: "refused",
        reason: `too long (subject ${LIMITS.subject}, predicate ${LIMITS.predicate}, object ${LIMITS.object} characters at most): memory holds short facts, not documents`,
        notes,
      };
    // Credentials never enter memory: facts are shown to models and may be committed to a repo.
    for (const [what, text] of [
      ["subject", subject],
      ["object", object],
    ] as const) {
      if (maskSecrets(text).hits.length)
        return {
          status: "refused",
          reason: `the ${what} looks like a credential, so it was not stored`,
          notes,
        };
    }

    const p = this.resolvePredicate(input.predicate);
    if (p.how === "alias" || p.how === "similar")
      notes.push(`predicate "${input.predicate.trim()}" is stored as ${p.canonical}`);
    const info = this.predicateInfo(p.canonical);
    const subj = this.resolveSubject(subject, where);
    if (subj !== subject) notes.push(`subject "${subject}" matches existing "${subj}"`);

    let scope: Scope = input.scope ?? "repo";
    if (info.codebase && scope === "everywhere") {
      scope = "repo";
      notes.push(`${p.canonical} describes a codebase, so it was kept to this repo instead of everywhere`);
    }
    const ref = this.scopeRef(scope, where);

    const sameSlot = (r: FactRow) =>
      r.scope === scope &&
      r.scope_ref === ref &&
      norm(r.subject) === norm(subj) &&
      r.predicate === p.canonical;
    const slot = (this.visibleRows(where, true) as FactRow[]).filter(sameSlot);

    if (input.retract) {
      const hit = slot.filter((r) => norm(r.object) === norm(object));
      if (!hit.length)
        return {
          status: "refused",
          reason: `no current ${scope}-scope fact "${subj} ${p.canonical} ${object}" to retract`,
          notes,
        };
      const closed = hit.map((r) => this.close(r.id, input.at));
      return { status: "retracted", closed, notes };
    }

    // Trust: capped by who is writing; an agent's "asserted" must be in the user's own words.
    let trust: Trust = input.trust ?? MAX_TRUST[input.writer];
    if (TRUST_RANK[trust] > TRUST_RANK[MAX_TRUST[input.writer]]) {
      if (
        input.writer === "agent" &&
        trust === "asserted" &&
        this.inUserWords(object, input.userWords ?? [])
      ) {
        // earned: the user said it
      } else {
        notes.push(`recorded as ${MAX_TRUST[input.writer]}: ${input.writer} claims cannot be asserted`);
        trust = MAX_TRUST[input.writer];
      }
    }
    if (input.writer === "user" && trust === "asserted") trust = "asserted";

    // Restatement: the same thing again adds no row.
    const same = slot.find((r) => norm(r.object) === norm(object));
    if (same) {
      if (TRUST_RANK[trust] > TRUST_RANK[same.trust])
        this.db.run("UPDATE facts SET trust = ?, writer = ? WHERE id = ?", [trust, input.writer, same.id]);
      return { status: "restated", fact: this.get(same.id)!, notes };
    }

    const closed: Fact[] = [];
    if (info.single && slot.length) {
      const top = Math.max(...slot.map((r) => TRUST_RANK[r.trust]));
      if (TRUST_RANK[trust] < top) {
        const keep = slot.find((r) => TRUST_RANK[r.trust] === top)!;
        notes.push(`a ${keep.trust} value already stands; ${trust} information does not replace it`);
        return { status: "kept", fact: toFact(keep), notes };
      }
      for (const r of slot) closed.push(this.close(r.id, input.at));
    }

    const res = this.db.run(
      `INSERT INTO facts (subject, predicate, object, scope, scope_ref, trust, writer, valid_at, created_at, source_archive_id, files)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        subj,
        p.canonical,
        object,
        scope,
        ref,
        trust,
        input.writer,
        input.at,
        input.at,
        input.sourceArchiveId ?? null,
        mentionedFiles(object),
      ],
    );
    if (p.how === "new") {
      this.db.run("INSERT OR IGNORE INTO predicates (canonical, single_valued, codebase) VALUES (?, 0, 0)", [
        p.canonical,
      ]);
      notes.push(
        `new predicate ${p.canonical} (multi-valued); see \`sieve memory review\` if it duplicates one`,
      );
    }
    return { status: "added", fact: this.get(Number(res.lastInsertRowid))!, closed, notes };
  }

  private close(id: number, at: number): Fact {
    this.db.run("UPDATE facts SET invalid_at = ?, expired_at = ? WHERE id = ? AND expired_at IS NULL", [
      at,
      at,
      id,
    ]);
    return this.get(id)!;
  }

  /** Close a fact by id (the user's edit, or a retraction from the review screen). */
  retractId(id: number, at: number): Fact | null {
    const f = this.get(id);
    if (!f || f.expiredAt !== null) return null;
    return this.close(id, at);
  }

  private inUserWords(object: string, words: string[]): boolean {
    const want = norm(object);
    if (!want) return false;
    return words.some((w) => norm(w).includes(want));
  }

  // -------------------------------------------------------------- reading for injection

  /** At most `limit` asserted facts for a stable block: no clock, so the text is identical across turns. */
  core(where: Where, limit = 8, keep: (f: Fact) => boolean = () => true): Fact[] {
    return this.active(where)
      .filter((f) => f.trust === "asserted" && keep(f))
      .sort((a, b) => SPECIFICITY[b.scope] - SPECIFICITY[a.scope] || a.id - b.id)
      .slice(0, limit);
  }

  /**
   * Facts that match the words of a request, ranked: relevance first, then newer (30-day half
   * life), then used often, then trust. A fact with no word in common is never returned, so the
   * block stays empty when memory has nothing to say.
   */
  relevant(
    where: Where,
    text: string,
    now: number,
    limit = 5,
    skip: ReadonlySet<number> = new Set(),
    keep: (f: Fact) => boolean = () => true,
  ): Fact[] {
    const want = terms(text);
    if (!want.length) return [];
    const scored: Array<{ f: Fact; score: number }> = [];
    for (const f of this.active(where)) {
      if (skip.has(f.id) || !keep(f)) continue;
      const lex = this.overlap(want, f);
      if (!lex) continue;
      scored.push({ f, score: this.score(f, lex, now) });
    }
    return scored
      .sort((a, b) => b.score - a.score || b.f.id - a.f.id)
      .slice(0, limit)
      .map((s) => s.f);
  }

  private overlap(want: string[], f: Fact): number {
    const hay = ` ${norm(`${f.subject} ${f.predicate} ${f.object}`)} `;
    let n = 0;
    for (const w of want) if (hay.includes(` ${w}`) || (w.length >= 5 && hay.includes(w))) n++;
    return n;
  }

  private score(f: Fact, lex: number, now: number): number {
    const ageDays = Math.max(0, now - (f.validAt ?? f.createdAt)) / DAY_MS;
    const decay = 0.5 ** (ageDays / HALF_LIFE_DAYS);
    const used = 1 + 0.15 * Math.log(1 + f.uses);
    const trust = f.trust === "asserted" ? 1 : f.trust === "observed" ? 0.8 : 0.6;
    return lex * decay * used * trust;
  }

  /** Query for the tool: ranked matches (or the newest facts with no query), with the use counted. */
  recall(where: Where, q: { query?: string; subject?: string }, now: number, limit = 10): Fact[] {
    let facts = this.active(where);
    if (q.subject) {
      const want = norm(q.subject);
      facts = facts.filter((f) => norm(f.subject) === want || similarity(norm(f.subject), want) >= 0.82);
    }
    const want = terms(q.query ?? "");
    let ranked: Fact[];
    if (want.length) {
      ranked = facts
        .map((f) => ({ f, lex: this.overlap(want, f) }))
        .filter((x) => x.lex > 0)
        .map((x) => ({ f: x.f, score: this.score(x.f, x.lex, now) }))
        .sort((a, b) => b.score - a.score || b.f.id - a.f.id)
        .map((x) => x.f);
    } else
      ranked = facts.sort((a, b) => (b.validAt ?? b.createdAt) - (a.validAt ?? a.createdAt) || b.id - a.id);
    const out = ranked.slice(0, limit);
    this.touch(out, now);
    return out;
  }

  /** Count a use: frequently used facts rank higher. */
  touch(facts: Fact[], now: number): void {
    for (const f of facts)
      this.db.run("UPDATE facts SET uses = uses + 1, last_used_at = ? WHERE id = ?", [now, f.id]);
  }

  // -------------------------------------------------------------- housekeeping

  /** Everything the user may want to look at: possible duplicates, unknown predicates, unconfirmed facts. */
  review(where: Where): Review {
    const facts = this.active(where);
    const duplicates: DuplicateGroup[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < facts.length; i++) {
      for (let j = i + 1; j < facts.length; j++) {
        const a = facts[i]!;
        const b = facts[j]!;
        const sameSubject =
          norm(a.subject) === norm(b.subject) || similarity(norm(a.subject), norm(b.subject)) >= 0.82;
        if (!sameSubject) continue;
        const objSim = similarity(norm(a.object), norm(b.object));
        const predSim = similarity(norm(a.predicate), norm(b.predicate));
        let reason: string | null = null;
        if (a.predicate === b.predicate && objSim >= 0.85 && norm(a.object) !== norm(b.object))
          reason = `same predicate, near-identical values (${Math.round(objSim * 100)}% alike)`;
        else if (a.predicate !== b.predicate && predSim >= 0.6 && objSim >= 0.6)
          reason = `similar predicates ("${a.predicate}" / "${b.predicate}") with similar values`;
        else if (a.predicate !== b.predicate && norm(a.object) === norm(b.object))
          reason = "different predicates, same value";
        if (!reason) continue;
        const key = `${a.id}-${b.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        duplicates.push({ reason, facts: [a, b] });
      }
    }
    const known = new Set(SEED.map((s) => s.canonical));
    const counts = new Map<string, number>();
    for (const f of facts)
      if (!known.has(f.predicate)) counts.set(f.predicate, (counts.get(f.predicate) ?? 0) + 1);
    const newPredicates = [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([predicate, count]) => {
        let closeTo: string | null = null;
        let best = 0.5;
        for (const s of SEED) {
          const v = similarity(norm(predicate), norm(s.canonical));
          if (v >= best) {
            best = v;
            closeTo = s.canonical;
          }
        }
        return { predicate, count, closeTo };
      });
    return { duplicates, newPredicates, unconfirmed: facts.filter((f) => f.trust !== "asserted") };
  }

  /** Delete facts closed before `before`. Never touches an active fact. Returns how many. */
  prune(before: number): number {
    const r = this.db.run("DELETE FROM facts WHERE expired_at IS NOT NULL AND expired_at < ?", [before]);
    return r.changes;
  }

  counts(): { active: number; closed: number } {
    const r = this.db
      .query(
        "SELECT SUM(expired_at IS NULL AND invalid_at IS NULL) AS a, SUM(expired_at IS NOT NULL OR invalid_at IS NOT NULL) AS c FROM facts",
      )
      .get() as { a: number | null; c: number | null };
    return { active: r.a ?? 0, closed: r.c ?? 0 };
  }

  // -------------------------------------------------------------- the text a model sees

  /** The scope label shown with a fact. */
  static label(f: Fact): string {
    return f.scope === "everywhere" ? "everywhere" : f.scope;
  }
}

/**
 * Relative file paths an object mentions (`src/limiter.ts`, `package.json`), at most 5. Used only
 * to notice that a file changed after the fact was written. Absolute paths and URLs are skipped.
 */
export function mentionedFiles(text: string): string | null {
  const out = new Set<string>();
  for (const m of text.matchAll(
    /(?<![\w/:.@-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,5})(?![\w/@-])/g,
  )) {
    const p = m[1]!;
    if (p.startsWith("/") || p.includes("..") || /^\d+(\.\d+)+$/.test(p)) continue;
    // a version, a domain or a sentence-ending word is not a path: require a known-looking extension
    if (
      !/\.(ts|tsx|js|jsx|mjs|cjs|json|toml|ya?ml|md|py|go|rs|rb|java|kt|swift|c|h|cpp|sh|sql|lock|env|txt|css|html)$/i.test(
        p,
      )
    )
      continue;
    out.add(p);
    if (out.size === 5) break;
  }
  return out.size ? JSON.stringify([...out]) : null;
}

export function formatFact(f: Fact): string {
  return `${f.subject} ${f.predicate.replace(/_/g, " ")}: ${f.object}`;
}
