import { ERROR_LINE } from "./errors.ts";
import { type Extraction, runExtractors } from "./extract/index.ts";
import { intentTerms } from "./intent.ts";
import { queryTerms } from "./search.ts";
import type { ArchivedItem } from "./store.ts";
import { byteLength, cleanTerminal, formatInt } from "./text.ts";

export const THRESHOLDS = {
  /** Output smaller than this passes through untouched. */
  passBelow: 1024,
  /** Agents that can replace results get a receipt above this. */
  replaceAbove: 4096,
  /** A fold is kept only if it saves at least this many characters... */
  minSaveChars: 768,
  /** ...and at least this fraction of the original. */
  minSaveRatio: 0.1,
} as const;

export interface FallbackBudget {
  head: number;
  tail: number;
  intent: number;
  /** Bytes for error and failure lines lifted out of the dropped middle. */
  errors: number;
}

/** Hook replies: first 6 KB plus last 2 KB. */
export const HOOK_BUDGET: FallbackBudget = { head: 6144, tail: 2048, intent: 1536, errors: 3072 };
/** sieve_run previews: at most 4 KB in total. */
export const RUN_PREVIEW_BUDGET: FallbackBudget = { head: 1536, tail: 1024, intent: 512, errors: 768 };

export interface FoldPlan {
  extractor: string;
  head: string;
  tail: string;
  /** 1-based inclusive range of dropped lines */
  omitted: { from: number; to: number };
  intentLines: string[];
  /** Error/failure lines (with two lines of context) from the dropped middle. */
  errorLines: string[];
}

export { ERROR_LINE };

const numbered = (i: number, l: string) =>
  `${String(i + 1).padStart(6)}│ ${l.length > 300 ? `${l.slice(0, 300)}…` : l}`;

/** Fallback extractor: whole lines from the start and end, plus middle lines matching intent. */
export function fallbackPlan(text: string, budget: FallbackBudget, intent?: string): FoldPlan | null {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  let h = 0;
  let used = 0;
  while (h < lines.length && used + byteLength(lines[h]!) + 1 <= budget.head)
    used += byteLength(lines[h++]!) + 1;
  let t = lines.length;
  used = 0;
  while (t > h && used + byteLength(lines[t - 1]!) + 1 <= budget.tail) used += byteLength(lines[--t]!) + 1;
  if (t <= h) return null;
  const intentLines: string[] = [];
  const terms = intentTerms(intent, true);
  if (terms.length) {
    // Keep only the best-matching lines, so "row 2500" does not pull in every line that
    // contains "row" or "22500". Whole-word hits count double, the exact phrase most.
    const phrase = (intent ?? "").toLowerCase().trim();
    let best = 0;
    const scored: Array<{ i: number; score: number }> = [];
    for (let i = h; i < t; i++) {
      const low = lines[i]!.toLowerCase();
      let score = 0;
      let words: Set<string> | null = null;
      for (const x of terms) {
        if (!low.includes(x)) continue;
        words ??= new Set(queryTerms(low));
        score += words.has(x) ? 2 : 1;
      }
      if (score > 0 && terms.length > 1 && low.includes(phrase)) score += 2 * terms.length;
      if (score === 0) continue;
      scored.push({ i, score });
      if (score > best) best = score;
    }
    let ib = 0;
    for (const { i, score } of scored) {
      if (score < best || intentLines.length >= 20) continue;
      const shown = numbered(i, lines[i]!);
      const b = byteLength(shown) + 1;
      if (ib + b > budget.intent) break;
      intentLines.push(shown);
      ib += b;
    }
  }
  const errorLines: string[] = [];
  const taken = new Set<number>();
  let eb = 0;
  for (let i = h; i < t && eb < budget.errors; i++) {
    if (!ERROR_LINE.test(lines[i]!)) continue;
    for (let k = i; k < Math.min(i + 3, t); k++) {
      if (taken.has(k)) continue;
      const shown = numbered(k, lines[k]!);
      const b = byteLength(shown) + 1;
      if (eb + b > budget.errors) break;
      taken.add(k);
      errorLines.push(shown);
      eb += b;
    }
  }
  return {
    extractor: "fallback",
    // If even the first line is over budget, show a byte prefix of it (it is still listed as omitted).
    head: h > 0 ? lines.slice(0, h).join("\n") : truncateBytes(lines[0] ?? "", budget.head),
    tail: lines.slice(t).join("\n"),
    omitted: { from: h + 1, to: t },
    intentLines,
    errorLines,
  };
}

function truncateBytes(s: string, n: number): string {
  return Buffer.from(s).subarray(0, n).toString("utf8").replace(/�$/, "");
}

/**
 * Render a receipt. A pure function of its inputs: no clock, no session, no counters, so
 * the same output always produces the same bytes (ADR 0003).
 */
export function renderReceipt(
  item: ArchivedItem,
  plan: FoldPlan,
  originalBytes: number,
  note?: string,
  preface?: string,
): string {
  const { from, to } = plan.omitted;
  const n = to - from + 1;
  const parts = [
    `[sieve ${item.id}] ${formatInt(item.tokens)} tokens (${item.tokenizer}), ${formatInt(item.lines)} lines`,
    `extractor: ${plan.extractor} · dropped: lines ${formatInt(from)}–${formatInt(to)} (${formatInt(n)} lines)${note ? ` · ${note}` : ""}`,
    ...(preface ? [preface] : []),
    "───",
    plan.head,
  ];
  parts.push(`… ${formatInt(n)} lines omitted …`);
  if (plan.errorLines.length) parts.push("errors and failures among them:", ...plan.errorLines);
  if (plan.intentLines.length) parts.push("lines among them matching your intent:", ...plan.intentLines);
  if (plan.errorLines.length || plan.intentLines.length) parts.push("…");
  if (plan.tail) parts.push(plan.tail);
  parts.push(
    "───",
    `Full output archived (${Math.round(originalBytes / 1024)} KB). Expand: sieve_get {"id":"${item.id}","lines":"${from}-${to}"}`,
    "Do not re-run the command to see more.",
  );
  return parts.join("\n");
}

/** Receipt for a format-aware extraction. Same purity rules as renderReceipt. */
export function renderExtraction(
  item: ArchivedItem,
  ex: Extraction,
  originalBytes: number,
  preface?: string,
): string {
  return [
    `[sieve ${item.id}] ${formatInt(item.tokens)} tokens (${item.tokenizer}), ${formatInt(item.lines)} lines`,
    `extractor: ${ex.extractor}${ex.dropped.length ? ` · dropped: ${ex.dropped.join(", ")}` : ""}`,
    ...(preface ? [preface] : []),
    "───",
    ex.body,
    "───",
    `Full output archived (${Math.round(originalBytes / 1024)} KB). Expand: sieve_get {"id":"${item.id}"}, or a range: {"id":"${item.id}","lines":"a-b"}`,
    "Do not re-run the command to see more.",
  ].join("\n");
}

/** Extractor bodies on the hook path aim for this size (failures may go to 3×). */
export const HOOK_EXTRACT_BUDGET = 16 * 1024;

export interface FoldInput {
  text: string;
  isError: boolean;
  intent?: string;
  command?: string;
  toolName?: string;
  pattern?: string;
  /** A line to put under the receipt header, e.g. a comparison with the previous run. */
  preface?: string;
}

export type FoldDecision = { kind: "pass" } | { kind: "replace"; text: string; extractor: string };

function worthIt(originalLen: number, newLen: number): boolean {
  const saved = originalLen - newLen;
  return saved >= THRESHOLDS.minSaveChars && saved >= originalLen * THRESHOLDS.minSaveRatio;
}

/**
 * Decide what the agent sees for one tool output (hook path). `item` is the archived
 * original; the caller archives before calling (nothing is lost).
 * - under 1 KB: pass
 * - errors: never cut, only cleaned of terminal codes
 * - over 4 KB: a format-aware extractor if one recognises the output, else the fallback
 *   (head, tail, error lines, intent lines); kept only if the saving clears both thresholds
 */
export function decideFold(input: FoldInput, item: ArchivedItem | null): FoldDecision {
  const { text } = input;
  if (text.length < THRESHOLDS.passBelow || !item) return { kind: "pass" };
  const cleaned = cleanTerminal(text);
  const cleanedOnly = (): FoldDecision =>
    worthIt(text.length, cleaned.length + 80)
      ? {
          kind: "replace",
          extractor: "clean",
          text: `${cleaned}\n[sieve ${item.id}] terminal codes removed; original: sieve_get {"id":"${item.id}"}`,
        }
      : { kind: "pass" };
  if (input.isError || byteLength(cleaned) <= THRESHOLDS.replaceAbove) return cleanedOnly();
  const ex = runExtractors({
    text: cleaned,
    isError: input.isError,
    budget: HOOK_EXTRACT_BUDGET,
    ...(input.intent ? { intent: input.intent } : {}),
    ...(input.command ? { command: input.command } : {}),
    ...(input.toolName ? { toolName: input.toolName } : {}),
    ...(input.pattern ? { pattern: input.pattern } : {}),
  });
  if (ex) {
    const receipt = renderExtraction(item, ex, byteLength(text), input.preface);
    if (worthIt(text.length, receipt.length))
      return { kind: "replace", text: receipt, extractor: ex.extractor };
  }
  const plan = fallbackPlan(cleaned, HOOK_BUDGET, input.intent);
  if (!plan) return cleanedOnly();
  const receipt = renderReceipt(item, plan, byteLength(text), undefined, input.preface);
  return worthIt(text.length, receipt.length)
    ? { kind: "replace", text: receipt, extractor: plan.extractor }
    : cleanedOnly();
}
