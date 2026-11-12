import { isErrorLine } from "../errors.ts";
import type { Extractor } from "./types.ts";
import { lines, plural } from "./util.ts";

/**
 * Any repetitive output that no format-aware extractor claimed (a test run in an unknown format, a
 * config dump, a progress log): lines are grouped by their template, each repeating template is shown
 * once with how many lines it covers and where, and the rare lines, usually the ones that matter
 * (the one failure, the one setting unlike the others), are kept verbatim with their line numbers.
 *
 * Why: the fallback (head and tail) sent 6,000 tokens of near-identical PASS lines and still left the
 * failure for the agent to fetch, a measured extra turn (ADR 0025). This keeps the anomaly in the receipt
 * itself, with no knowledge of what the user asked, so the receipt stays a pure function of the output.
 *
 * Templates keep words and replace only what varies: long hex ids and numbers, also inside words
 * (case12, user137). So `PAYMENTS_SERVICE_PORT=8443` and `SERVICE_7_TIMEOUT_MS=1007` stay apart, which a
 * whitespace-token clustering that masks any token holding a digit would merge. Error lines are never
 * folded away.
 */

const REPEAT = 3;
const MAX_ERRORS = 30;
const MAX_INTENT_LINES = 8;

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * Lines holding a word of the caller's stated intent (a tool argument, e.g. sieve_run's `intent`) that
 * is rare in this output: folding must not hide the very line asked for. Part of the tool input, so the
 * receipt stays a pure function of its input.
 */
function intentLines(ls: string[], intent: string | undefined): number[] {
  if (!intent) return [];
  const terms = words(intent).filter((w) => w.length >= 3 || /^\d+$/.test(w));
  if (!terms.length) return [];
  const sets = ls.map((l) => new Set(words(l)));
  const rare = terms.filter((t) => {
    let c = 0;
    for (const s of sets) if (s.has(t)) c++;
    return c > 0 && c <= Math.max(1, ls.length * 0.05);
  });
  if (!rare.length) return [];
  const out: number[] = [];
  for (let i = 0; i < ls.length && out.length < MAX_INTENT_LINES; i++)
    if (rare.some((t) => sets[i]!.has(t))) out.push(i);
  return out;
}

export function template(line: string): string {
  return line.replace(/\b[0-9a-f]{12,}\b/gi, "<h>").replace(/\d+/g, "<n>");
}

interface Group {
  tpl: string;
  count: number;
  first: number;
  last: number;
  errors: number[];
}

function group(ls: string[]): Group[] {
  const by = new Map<string, Group>();
  const order: Group[] = [];
  ls.forEach((line, i) => {
    if (!line.trim()) return;
    const tpl = template(line);
    let g = by.get(tpl);
    if (!g) {
      g = { tpl, count: 0, first: i, last: i, errors: [] };
      by.set(tpl, g);
      order.push(g);
    }
    g.count++;
    g.last = i;
    if (isErrorLine(line)) g.errors.push(i);
  });
  return order;
}

export const repeats: Extractor = {
  id: "repeats",
  detect: ({ text }) => {
    const ls = lines(text).filter((l) => l.trim());
    if (ls.length < 40) return 0;
    const groups = group(ls);
    const covered = groups.filter((g) => g.count >= REPEAT).reduce((n, g) => n + g.count, 0);
    // Repetitive enough that folding pays: few templates, and most lines in a repeating one. Scored just
    // above the floor, so any format-aware extractor that recognises the output still wins.
    return groups.length <= ls.length * 0.3 && covered >= ls.length * 0.6 ? 55 : 0;
  },
  extract({ text, intent }) {
    const ls = lines(text);
    const groups = group(ls);
    const out: string[] = [
      `${plural(ls.filter((l) => l.trim()).length, "line")} in ${plural(groups.length, "template")}:`,
    ];
    let folded = 0;
    let templates = 0;
    // In the order each template first appears, so the receipt reads like the output.
    for (const g of groups) {
      if (g.count < REPEAT) {
        for (let i = g.first; i <= g.last; i++)
          if (template(ls[i]!) === g.tpl) out.push(`L${i + 1}: ${ls[i]}`);
        continue;
      }
      folded += g.count;
      templates++;
      out.push(`${g.count}× ${g.tpl}   (L${g.first + 1}–L${g.last + 1})`);
      for (const i of g.errors.slice(0, MAX_ERRORS)) out.push(`    error L${i + 1}: ${ls[i]}`);
      if (g.errors.length > MAX_ERRORS)
        out.push(`    … ${g.errors.length - MAX_ERRORS} more error lines in this template (in the archive)`);
    }
    const asked = intentLines(ls, intent);
    if (asked.length) out.push("lines matching the intent:", ...asked.map((i) => `L${i + 1}: ${ls[i]}`));
    return {
      extractor: "repeats",
      body: out.join("\n"),
      dropped: [`${plural(folded, "line")} folded into ${plural(templates, "repeating template")}`],
      keptVerbatim: groups.some((g) => g.errors.length > 0),
    };
  },
};
