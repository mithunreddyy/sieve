import { mkdtempSync, rmSync } from "node:fs";
import { hashReranker, ProjectStore, search } from "@sieve/core";

/**
 * Does the built-in reranker help or hurt full-text search? A small labelled set: each query has
 * exactly one archived item that answers it. Reported as recall@1 and recall@3, with and without the
 * reranker. The set is written to include cases the words alone get wrong (identifier styles, word
 * forms) and cases they get right, so the report can show a loss as well as a gain.
 */

const DOCS: Record<string, string> = {
  limiter:
    "RateLimiter middleware rejects a request after five attempts per minute and returns HTTP 429 with a Retry-After header",
  auth: "The login handler verifies the password hash with argon2 and issues a session cookie that expires after twelve hours",
  cache:
    "The response cache stores entries keyed by URL and evicts the least recently used item when the limit of 500 entries is reached",
  migrate:
    "Run the database migration with bun run migrate; each migration file is applied once and recorded in the schema_migrations table",
  upload:
    "File uploads are streamed to disk in 8 MB chunks and virus scanned before the record becomes visible to other users",
  retry:
    "The HTTP client retries failed requests with exponential backoff, doubling the delay up to a maximum of thirty seconds",
  logging:
    "Structured log lines are written as JSON with a request id, level and timestamp, and rotated daily by the log shipper",
  search:
    "Full text search uses a trigram index so that misspelled words still match, and results are ranked by recency",
  deploy:
    "Deployment pushes the container image to the registry and rolls out new pods one at a time with a readiness probe",
  flags:
    "Feature flags are read from the config service at startup and refreshed every minute without restarting the process",
  queue:
    "Background jobs are placed on a queue and workers pick them up, retrying a failed job three times before parking it",
  pagination:
    "List endpoints paginate with an opaque cursor; pass the cursor from the previous response to fetch the next page",
};

const QUERIES: Array<[string, string]> = [
  ["rate limiting", "limiter"],
  ["limit requests per minute", "limiter"],
  ["too many requests 429", "limiter"],
  ["how are passwords hashed", "auth"],
  ["session cookie expiry", "auth"],
  ["evict old cache entries", "cache"],
  ["caching of responses", "cache"],
  ["applying migrations", "migrate"],
  ["schema_migrations table", "migrate"],
  ["uploading large files", "upload"],
  ["scan uploaded file for viruses", "upload"],
  ["retrying failed http calls", "retry"],
  ["backoff delay", "retry"],
  ["json logs with request id", "logging"],
  ["log rotation", "logging"],
  ["misspelled search words", "search"],
  ["trigram", "search"],
  ["roll out pods", "deploy"],
  ["push image to registry", "deploy"],
  ["refresh feature flags", "flags"],
  ["flag configuration reload", "flags"],
  ["failed jobs retried", "queue"],
  ["worker queue", "queue"],
  ["next page cursor", "pagination"],
  ["paginating lists", "pagination"],
];

export interface RerankReport {
  queries: number;
  off: { at1: number; at3: number };
  hash: { at1: number; at3: number };
  changed: Array<{ query: string; off: number | null; hash: number | null }>;
}

export function runRerankEval(): RerankReport {
  const home = mkdtempSync("/tmp/svb-rr-");
  process.env.SIEVE_HOME = home;
  const ref = { key: "rr", root: home, name: "rr", worktree: home };
  const store = new ProjectStore(ref);
  try {
    const idToName = new Map<string, string>();
    for (const [name, text] of Object.entries(DOCS)) {
      const it = store.put(text, { sessionId: "s", worktree: home, sourceKind: "tool", source: name, at: 1 });
      idToName.set(it.id, name);
      for (let i = 0; i < 1000 && !store.indexStep(it.id, 1_000_000).done; i++);
    }
    const rankOf = (q: string, want: string, rerank: boolean): number | null => {
      const page = search(store.db, {
        query: q,
        scope: "project",
        worktree: home,
        ...(rerank ? { rerank: hashReranker } : {}),
      });
      // search pages by five; look at the first page, which is all recall@3 needs
      const i = page.hits.findIndex((h) => idToName.get(h.archiveId) === want);
      return i === -1 ? null : i + 1;
    };
    const r: RerankReport = {
      queries: QUERIES.length,
      off: { at1: 0, at3: 0 },
      hash: { at1: 0, at3: 0 },
      changed: [],
    };
    for (const [q, want] of QUERIES) {
      const a = rankOf(q, want, false);
      const b = rankOf(q, want, true);
      if (a === 1) r.off.at1++;
      if (a !== null && a <= 3) r.off.at3++;
      if (b === 1) r.hash.at1++;
      if (b !== null && b <= 3) r.hash.at3++;
      if (a !== b) r.changed.push({ query: q, off: a, hash: b });
    }
    return r;
  } finally {
    store.db.close();
    rmSync(home, { recursive: true, force: true });
  }
}
