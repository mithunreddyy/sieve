import { ERROR_LINE } from "../errors.ts";
import type { Extractor } from "./types.ts";
import { compact, lines, plural, share } from "./util.ts";

const LOG_LINE =
  /^(\[?\d{4}-\d{2}-\d{2}[T ]\d|\[?\d{2}:\d{2}:\d{2}|\w{3} {1,2}\d{1,2} \d{2}:\d{2}|(npm|yarn|pnpm) (silly|verbose|http|info|timing|warn|error)|\[?(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|FATAL|CRITICAL)\]?\b|time=|level=|\{"(time|level|ts|msg)")/;

/** A token is variable if it contains a digit, or looks like a path, URL, hex id or quoted value. */
const VARIABLE = /\d|^[a-f0-9]{8,}$|^(https?:|\/|\.\/)|^["'].*["']$|@/i;

interface Cluster {
  tokens: string[];
  count: number;
  first: number;
  last: number;
  firstLine: string;
  lastLine: string;
  errors: number[];
}

/**
 * Drain-style template clustering: lines with the same token count and first two words are
 * merged when at least 60% of tokens agree exactly (variable tokens are pre-masked as <*>); the positions that differ become <*>.
 * Clusters print as "N× template" with their first and last example. Error lines are
 * never folded away: every error-like line is kept (up to 30 per cluster, then counted).
 */
export function cluster(ls: string[]): Cluster[] {
  const buckets = new Map<string, Cluster[]>();
  const all: Cluster[] = [];
  ls.forEach((line, i) => {
    if (!line.trim()) return;
    const toks = line
      .trim()
      .split(/\s+/)
      .map((t) => (VARIABLE.test(t) ? "<*>" : t));
    // Bucket on length and the first two tokens (Drain's prefix tree, two levels deep).
    const key = `${toks.length}\u0000${toks[0]}\u0000${toks.length > 2 ? toks[1] : ""}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    let best: Cluster | null = null;
    let bestSim = 0;
    for (const c of bucket) {
      let same = 0;
      // Only exact agreement counts. Letting a wildcard match anything makes templates swallow
      // unrelated lines once they have generalised (all 5-token "npm …" lines become one).
      for (let k = 0; k < toks.length; k++) if (c.tokens[k] === toks[k]) same++;
      const sim = same / toks.length;
      if (sim >= 0.6 && sim > bestSim) {
        best = c;
        bestSim = sim;
      }
    }
    const isErr = ERROR_LINE.test(line);
    if (best) {
      best.tokens = best.tokens.map((t, k) => (t === toks[k] ? t : "<*>"));
      best.count++;
      best.last = i;
      best.lastLine = line;
      if (isErr) best.errors.push(i);
    } else {
      const c: Cluster = {
        tokens: toks,
        count: 1,
        first: i,
        last: i,
        firstLine: line,
        lastLine: line,
        errors: isErr ? [i] : [],
      };
      bucket.push(c);
      all.push(c);
    }
  });
  return all;
}

export const logs: Extractor = {
  id: "logs",
  detect: ({ text }) => {
    const ls = lines(text);
    if (ls.length < 40) return 0;
    const sh = share(ls, LOG_LINE);
    // Almost every line a log line: clustering beats any command-based guess (npm --loglevel silly).
    return sh >= 0.85 ? 92 : sh >= 0.6 ? 60 : 0;
  },
  extract({ text }) {
    const ls = lines(text);
    const clusters = cluster(ls);
    if (clusters.length >= ls.length * 0.8) return null; // nothing repeats; clustering would not help
    const out: string[] = [`${plural(ls.length, "line")} in ${plural(clusters.length, "pattern")}:`];
    let folded = 0;
    for (const c of clusters) {
      if (c.count === 1) {
        out.push(`L${c.first + 1}: ${c.firstLine}`);
        continue;
      }
      folded += c.count;
      out.push(`${c.count}× ${c.tokens.join(" ")}`);
      out.push(`    first L${c.first + 1}: ${c.firstLine}`);
      if (c.last !== c.first) out.push(`    last  L${c.last + 1}: ${c.lastLine}`);
      const errs = c.errors.filter((i) => i !== c.first && i !== c.last);
      for (const i of errs.slice(0, 30)) out.push(`    error L${i + 1}: ${ls[i]}`);
      if (errs.length > 30)
        out.push(`    … ${errs.length - 30} more error lines in this pattern (in the archive)`);
    }
    return {
      extractor: "logs",
      body: out.join("\n"),
      dropped: compact([
        folded > 0 &&
          `${plural(folded, "line")} folded into repeating patterns (first and last of each kept)`,
      ]),
      keptVerbatim: clusters.some((c) => c.errors.length > 0),
    };
  },
};
