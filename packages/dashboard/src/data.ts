import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { type Fact, type FactRow, GlobalStore, loadConfig, paths, THRESHOLDS } from "@sieve/core";
import { AuditLog } from "@sieve/guard";

/**
 * Everything the dashboard and the terminal view show, read straight from the databases the
 * daemon writes (opened read-only), so they work whether or not the daemon is running.
 */

export interface Bucket {
  key: string;
  count: number;
  tokensIn: number;
  tokensOut: number;
}

export interface ReceiptRow {
  at: number;
  project: string;
  projectName: string;
  session: string;
  agent: string;
  tool: string;
  kind: "fold" | "rerun" | "pass";
  extractor: string | null;
  archiveId: string | null;
  tokensIn: number;
  tokensOut: number;
  source: string | null;
  canary: boolean;
  /** Why it was cut, in words, from the recorded numbers. Deterministic. */
  why: string;
}

export interface Snapshot {
  generatedAt: number;
  totals: { folds: number; tokensIn: number; tokensOut: number; saved: number; savedPct: number };
  /** Dollars at the list price set in config, for tokens that were not sent. An estimate, not a measurement. */
  dollars: { saved: number; perMillionInput: number };
  /** Only the proxy can measure this; null until it has served a request. */
  cacheHitRate: number | null;
  /** What the local proxy did, when it has served requests. */
  proxy: {
    calls: number;
    trimmedBytes: number;
    folded: number;
    archived: number;
    marksAdded: number;
    failedOpen: number;
    dollars: number;
  } | null;
  byAgent: Bucket[];
  byTool: Bucket[];
  byExtractor: Bucket[];
  bySession: Bucket[];
  receipts: ReceiptRow[];
  canaries: number;
  facts: Array<Fact & { source: string }>;
  guard: Array<{
    at: number;
    decision: string;
    rule?: string;
    tool: string;
    program?: string;
    mode: string;
    reason?: string;
  }>;
  hooks: Array<{ agent: string; event: string; lastAt: number; count: number }>;
  projects: Array<{ key: string; name: string; root: string; archivedItems: number; archivedTokens: number }>;
}

const open = (file: string): Database | null => {
  if (!existsSync(file)) return null;
  try {
    return new Database(file, { readonly: true });
  } catch {
    return null;
  }
};

const bucket = (rows: Array<{ k: string | null; n: number; i: number; o: number }>): Bucket[] =>
  rows
    .map((r) => ({ key: r.k ?? "(none)", count: r.n, tokensIn: r.i, tokensOut: r.o }))
    .sort((a, b) => b.tokensIn - b.tokensOut - (a.tokensIn - a.tokensOut));

export function whyCut(r: {
  kind: string;
  extractor: string | null;
  tokensIn: number;
  tokensOut: number;
}): string {
  if (r.kind === "pass")
    return `Left as it was: ${r.tokensIn.toLocaleString("en-US")} tokens, but a shorter version would not have saved enough to be worth replacing (at least ${THRESHOLDS.minSaveChars} characters and ${Math.round(THRESHOLDS.minSaveRatio * 100)}% must go).`;
  if (r.kind === "rerun")
    return `The same command ran again: only what changed since the last run was sent (${r.tokensIn.toLocaleString("en-US")} → ${r.tokensOut.toLocaleString("en-US")} tokens).`;
  return `Output of ${r.tokensIn.toLocaleString("en-US")} tokens was over the ${THRESHOLDS.replaceAbove}-character line for a receipt. The ${r.extractor ?? "default"} extractor kept ${r.tokensOut.toLocaleString("en-US")} tokens: the head, the tail, any errors and the lines matching the intent. The original is archived byte for byte.`;
}

export function collect(opts: { limit?: number } = {}): Snapshot {
  const limit = opts.limit ?? 100;
  const cfg = loadConfig();
  const gs = new GlobalStore(paths.globalDb());
  try {
    const projects = gs.db
      .query("SELECT key, name, root FROM projects ORDER BY last_open_at DESC")
      .all() as Array<{
      key: string;
      name: string;
      root: string;
    }>;
    type Agg = { k: string | null; n: number; i: number; o: number };
    const agg = { agent: [] as Agg[], tool: [] as Agg[], extractor: [] as Agg[], session: [] as Agg[] };
    const receipts: ReceiptRow[] = [];
    const proj: Snapshot["projects"] = [];
    let folds = 0;
    let tin = 0;
    let tout = 0;
    let canaries = 0;
    for (const p of projects) {
      const db = open(paths.projectDb(p.key));
      if (!db) continue;
      try {
        const has = db.query("SELECT name FROM sqlite_master WHERE name = 'folds'").get();
        const a = db.query("SELECT COUNT(*) AS n, COALESCE(SUM(tokens),0) AS t FROM archive").get() as {
          n: number;
          t: number;
        };
        proj.push({ key: p.key, name: p.name, root: p.root, archivedItems: a.n, archivedTokens: a.t });
        if (!has) continue;
        const t = db
          .query(
            "SELECT COUNT(*) AS n, COALESCE(SUM(tokens_in),0) AS i, COALESCE(SUM(tokens_out),0) AS o FROM folds WHERE kind <> 'pass'",
          )
          .get() as { n: number; i: number; o: number };
        folds += t.n;
        tin += t.i;
        tout += t.o;
        canaries += (db.query("SELECT COUNT(*) AS n FROM folds WHERE canary = 1").get() as { n: number }).n;
        for (const [name, col] of [
          ["agent", "agent"],
          ["tool", "tool"],
          ["extractor", "extractor"],
          ["session", "session_id"],
        ] as const) {
          const rows = db
            .query(
              `SELECT ${col} AS k, COUNT(*) AS n, SUM(tokens_in) AS i, SUM(tokens_out) AS o FROM folds WHERE kind <> 'pass' GROUP BY ${col}`,
            )
            .all() as Array<{ k: string | null; n: number; i: number; o: number }>;
          agg[name].push(...rows.map((r) => (name === "session" ? { ...r, k: `${p.name}: ${r.k}` } : r)));
        }
        const recent = db
          .query(
            "SELECT at, session_id, agent, tool, kind, extractor, archive_id, tokens_in, tokens_out, source, canary FROM folds ORDER BY id DESC LIMIT ?",
          )
          .all(limit) as Array<{
          at: number;
          session_id: string;
          agent: string;
          tool: string;
          kind: ReceiptRow["kind"];
          extractor: string | null;
          archive_id: string | null;
          tokens_in: number;
          tokens_out: number;
          source: string | null;
          canary: number;
        }>;
        for (const r of recent)
          receipts.push({
            at: r.at,
            project: p.key,
            projectName: p.name,
            session: r.session_id,
            agent: r.agent,
            tool: r.tool,
            kind: r.kind,
            extractor: r.extractor,
            archiveId: r.archive_id,
            tokensIn: r.tokens_in,
            tokensOut: r.tokens_out,
            source: r.source,
            canary: r.canary === 1,
            why: whyCut({
              kind: r.kind,
              extractor: r.extractor,
              tokensIn: r.tokens_in,
              tokensOut: r.tokens_out,
            }),
          });
      } finally {
        db.close();
      }
    }
    // Merge buckets that appear in several projects.
    const merge = (rows: Array<{ k: string | null; n: number; i: number; o: number }>): Bucket[] => {
      const m = new Map<string, { k: string; n: number; i: number; o: number }>();
      for (const r of rows) {
        const k = r.k ?? "(none)";
        const cur = m.get(k) ?? { k, n: 0, i: 0, o: 0 };
        cur.n += r.n;
        cur.i += r.i;
        cur.o += r.o;
        m.set(k, cur);
      }
      return bucket([...m.values()]);
    };
    const saved = Math.max(0, tin - tout);
    // `memory.active` is scoped to a place; the dashboard lists every active fact.
    const allFacts = (
      gs.db
        .query(
          "SELECT * FROM facts WHERE expired_at IS NULL AND invalid_at IS NULL ORDER BY id DESC LIMIT 200",
        )
        .all() as FactRow[]
    ).map((r): Fact & { source: string } => ({
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
      files: r.files ? JSON.parse(r.files) : [],
      uses: r.uses,
      lastUsedAt: r.last_used_at,
      source: `${r.writer}${r.source_archive_id ? `, from ${r.source_archive_id}` : ""}`,
    }));
    const pr = gs.db
      .query(
        `SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(cache_read),0) AS r, COALESCE(SUM(cache_write),0) AS w,
           COALESCE(SUM(trimmed_bytes),0) AS tb, COALESCE(SUM(folded),0) AS f, COALESCE(SUM(archived),0) AS a,
           COALESCE(SUM(marks_added),0) AS m, COALESCE(SUM(failed_open IS NOT NULL),0) AS fo, COALESCE(SUM(dollars),0) AS d FROM proxy_calls`,
      )
      .get() as {
      n: number;
      i: number;
      r: number;
      w: number;
      tb: number;
      f: number;
      a: number;
      m: number;
      fo: number;
      d: number;
    };
    const proxy = {
      rate: pr.n && pr.i + pr.r + pr.w > 0 ? Math.round((pr.r / (pr.i + pr.r + pr.w)) * 1000) / 1000 : null,
      summary: pr.n
        ? {
            calls: pr.n,
            trimmedBytes: pr.tb,
            folded: pr.f,
            archived: pr.a,
            marksAdded: pr.m,
            failedOpen: pr.fo,
            dollars: Math.round(pr.d * 100) / 100,
          }
        : null,
    };
    const audit = new AuditLog(join(paths.home(), "guard", "audit.jsonl"));
    const guard = audit
      .rows()
      .slice(-100)
      .reverse()
      .map((r) => ({
        at: r.at,
        decision: r.decision,
        rule: r.rule,
        tool: r.tool ?? "",
        program: r.program,
        mode: r.mode ?? "",
      }));
    return {
      generatedAt: Date.now(),
      totals: {
        folds,
        tokensIn: tin,
        tokensOut: tout,
        saved,
        savedPct: tin ? Math.round((saved / tin) * 100) : 0,
      },
      dollars: {
        saved: Math.round((saved / 1_000_000) * cfg.prices.input_per_mtok * 100) / 100,
        perMillionInput: cfg.prices.input_per_mtok,
      },
      cacheHitRate: proxy.rate,
      proxy: proxy.summary,
      byAgent: merge(agg.agent),
      byTool: merge(agg.tool),
      byExtractor: merge(agg.extractor),
      bySession: merge(agg.session).slice(0, 15),
      receipts: receipts.sort((a, b) => b.at - a.at).slice(0, limit),
      canaries,
      facts: allFacts,
      guard,
      hooks: gs.health(),
      projects: proj,
    };
  } finally {
    gs.close();
  }
}

/** The archived original of an item, for "view original". Reads the project database read-only. */
export function original(projectKey: string, id: string): { text: string; bytes: number } | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectKey) || !/^s_[a-z2-7]+$/.test(id)) return null;
  const db = open(paths.projectDb(projectKey));
  if (!db) return null;
  try {
    const r = db.query("SELECT content, bytes FROM archive WHERE id = ?").get(id) as {
      content: Uint8Array;
      bytes: number;
    } | null;
    if (!r) return null;
    const buf = Buffer.from(r.content);
    let text: string;
    try {
      text = gunzipSync(buf).toString("utf8");
    } catch {
      text = buf.toString("utf8");
    }
    return { text, bytes: r.bytes };
  } finally {
    db.close();
  }
}
