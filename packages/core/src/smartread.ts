import { boundedDiff } from "./boundeddiff.ts";
import { fallbackPlan } from "./fold.ts";
import { intentTerms } from "./intent.ts";
import type { OutlineSymbol } from "./outline/index.ts";
import { queryTerms } from "./search.ts";
import type { FileState, ReadRow } from "./store.ts";
import { byteLength, countLines, formatInt } from "./text.ts";

export interface ReadInput {
  /** Path as shown to the agent (relative to the worktree when inside it). */
  path: string;
  text: string;
  state: FileState;
  /** Real token count, or null when it is not known yet (very large files; size is shown instead). */
  tokens: number | null;
  /** The reader's latest read of this file in the current epoch. */
  last: ReadRow | null;
  /** The archived content of that read, when available. */
  lastText: string | null;
  symbols: OutlineSymbol[] | null;
  intent?: string;
  outlineAboveBytes: number;
  /** How the agent gets the whole file anyway, e.g. "read it again" or 'sieve_read with "full": true'. */
  again: string;
  /** How the agent asks for a range, e.g. "Read with offset/limit". */
  rangeHint: (from: number, to: number) => string;
}

export type ReadDecision = { kind: "full" } | { kind: "unchanged" | "changed" | "outline"; message: string };

const OUTLINE_BUDGET = 6 * 1024;
const cost = (i: ReadInput) =>
  i.tokens === null ? `${Math.round(i.state.size / 1024)} KB` : `${formatInt(i.tokens)} tokens`;
const INTENT_BUDGET = 4 * 1024;

/**
 * Decide what a full read of a file should return. Pure: the same inputs give the same
 * bytes. "Unchanged" is only claimed for the same reader (session + agent context) in the
 * same compaction epoch, after a full read or its own edit.
 */
export function decideRead(i: ReadInput): ReadDecision {
  const knows = i.last && (i.last.kind === "full" || i.last.kind === "edit");
  if (knows && i.last!.contentId === i.state.contentId) {
    const how =
      i.last!.kind === "edit"
        ? `your own edit after read #${i.last!.readNo}`
        : `your read #${i.last!.readNo}`;
    return {
      kind: "unchanged",
      message: `[sieve read] ${i.path} is unchanged since ${how} in this session (same bytes, ${cost(i)}). It is still in your context, so it was not sent again. ${cap(i.again)} if you need it anyway.`,
    };
  }
  if (knows && i.lastText !== null) {
    const d = boundedDiff(i.lastText, i.text, 0.4, 2);
    const hunks = { length: d?.hunks ?? 0 };
    const body = d?.body ?? "";
    const add = d?.add ?? 0;
    const del = d?.del ?? 0;
    if (hunks.length && byteLength(body) <= Math.min(i.state.size * 0.4, 16 * 1024)) {
      return {
        kind: "changed",
        message: `[sieve read] ${i.path} changed since your read #${i.last!.readNo} (+${add} −${del} lines in ${hunks.length} hunk${hunks.length === 1 ? "" : "s"}). Only the changes are shown; line numbers are the new file's. ${cap(i.again)} for the whole file (${cost(i)}).\n${body}`,
      };
    }
  }
  if (i.state.size <= i.outlineAboveBytes) return { kind: "full" };
  return { kind: "outline", message: renderOutline(i) };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const numbered = (n: number, l: string) =>
  `${String(n).padStart(6)}│ ${l.length > 240 ? `${l.slice(0, 240)}…` : l}`;

function renderOutline(i: ReadInput): string {
  const lines = i.text.split("\n");
  const total = countLines(i.text);
  const out = [
    `[sieve read] ${i.path}: ${formatInt(total)} lines, ${cost(i)}. Too large to send whole on first read; here is its outline.`,
  ];
  let firstRange: [number, number] | null = null;

  if (i.symbols?.length) {
    // Drop the deepest symbols first until the outline fits.
    let maxDepth = Math.max(...i.symbols.map((s) => s.depth));
    let shown = i.symbols;
    const render = (syms: OutlineSymbol[]) =>
      syms.map(
        (s) =>
          `${`${s.startLine}-${s.endLine}`.padStart(11)}  ${"  ".repeat(s.depth)}${s.signature || `${s.kind} ${s.name}`}`,
      );
    let rendered = render(shown);
    const size = (xs: string[]) => xs.reduce((n, l) => n + byteLength(l) + 1, 0);
    while (size(rendered) > OUTLINE_BUDGET && maxDepth > 0) {
      maxDepth--;
      shown = i.symbols.filter((s) => s.depth <= maxDepth);
      rendered = render(shown);
    }
    // Still too long: keep whole lines up to the budget in one pass.
    let used = 0;
    let keep = 0;
    while (keep < rendered.length && used + byteLength(rendered[keep]!) + 1 <= OUTLINE_BUDGET)
      used += byteLength(rendered[keep++]!) + 1;
    keep = Math.max(1, keep);
    const cut = rendered.length - keep;
    rendered = rendered.slice(0, keep);
    const hidden = i.symbols.length - shown.length + cut;
    out.push(`outline (${formatInt(i.symbols.length)} symbols, line ranges):`, ...rendered);
    if (hidden) out.push(`  … ${formatInt(hidden)} more (nested or later) symbols not shown`);
    firstRange = [i.symbols[0]!.startLine, i.symbols[0]!.endLine];
  } else {
    // No outline for this kind of file: show its start and end.
    const plan = fallbackPlan(i.text, { head: 2048, tail: 1024, intent: 0, errors: 0 }, undefined);
    if (plan) {
      out.push(
        `start (lines 1-${plan.omitted.from - 1}):`,
        plan.head,
        `… lines ${plan.omitted.from}-${plan.omitted.to} not shown …`,
        `end:`,
        plan.tail,
      );
    }
  }

  const ranges = intentRanges(lines, i.symbols, i.intent);
  if (ranges.length) {
    out.push("", `lines matching your request (${intentTerms(i.intent).join(", ")}):`);
    let used = 0;
    for (const [a, b] of ranges) {
      const block = [`  lines ${a}-${b}:`, ...lines.slice(a - 1, b).map((l, k) => numbered(a + k, l))];
      const size = byteLength(block.join("\n"));
      if (used + size > INTENT_BUDGET) break;
      out.push(...block);
      used += size;
    }
    firstRange = ranges[0]!;
  }
  const [a, b] = firstRange ?? [1, Math.min(total, 200)];
  out.push("", `${i.rangeHint(a, b)} for the part you need, or ${i.again} for the whole file (${cost(i)}).`);
  return out.join("\n");
}

/**
 * Up to four line ranges around the best matches for the intent, best first: the smallest
 * enclosing symbol when it is short, else the match ±3 lines.
 */
export function intentRanges(
  lines: string[],
  symbols: OutlineSymbol[] | null,
  intent?: string,
): Array<[number, number]> {
  const terms = intentTerms(intent);
  if (!terms.length) return [];
  const low = lines.map((l) => l.toLowerCase());
  // Rare terms matter more: "handler417" on one line beats "rate" on six hundred.
  const weight = new Map(
    terms.map((t) => {
      const df = low.reduce((n, l) => n + (l.includes(t) ? 1 : 0), 0);
      return [t, df ? 1 / (1 + Math.log2(df)) : 0];
    }),
  );
  // A line that declares a symbol named in the request outranks lines that only mention it.
  const declared = new Map<number, number>();
  for (const s of symbols ?? []) {
    const name = s.name.toLowerCase();
    if (weight.has(name))
      declared.set(s.startLine, (declared.get(s.startLine) ?? 0) + 2 * weight.get(name)! + 1);
  }
  const scored: Array<{ n: number; score: number }> = [];
  low.forEach((l, k) => {
    let score = 0;
    let words: Set<string> | null = null;
    for (const t of terms) {
      if (!l.includes(t)) continue;
      words ??= new Set(queryTerms(l));
      score += weight.get(t)! * (words.has(t) ? 2 : 1);
    }
    if (score > 0) scored.push({ n: k + 1, score: score + (declared.get(k + 1) ?? 0) });
  });
  scored.sort((x, y) => y.score - x.score || x.n - y.n);
  const ranges: Array<[number, number]> = [];
  for (const { n } of scored) {
    if (ranges.some(([a, b]) => n >= a && n <= b)) continue;
    const sym = (symbols ?? [])
      .filter((s) => s.startLine <= n && s.endLine >= n && s.endLine - s.startLine <= 40)
      .sort((x, y) => x.endLine - x.startLine - (y.endLine - y.startLine))[0];
    ranges.push(sym ? [sym.startLine, sym.endLine] : [Math.max(1, n - 3), Math.min(lines.length, n + 3)]);
    if (ranges.length >= 4) break;
  }
  return ranges;
}
