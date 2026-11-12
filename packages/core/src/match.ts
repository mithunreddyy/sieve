import { cleanPrompt } from "./intent.ts";
import { byteLength } from "./text.ts";

/**
 * The lines of a tool output that answer what the user asked, sent as a note next to the receipt.
 *
 * Why: a paired live run (ADR 0022) showed that when the answer is one record in a long list, the
 * receipt drops it and the agent spends two extra turns fetching it, each re-reading the whole cached
 * context. The receipt cannot use the prompt: it must stay a pure function of the output (invariant 3).
 * This note is separate context, like recall notes, so it can.
 *
 * How (Sieve's own design): the prompt's words, numbers included, are matched against each line's
 * words. Only RARE words count: one that appears in more than 5% of the lines ("user", "email" in a
 * user list) says nothing about which line is wanted; one that appears in a few ("137") does. Lines
 * are scored by the rarity (log N/df) of the words they contain, the best few are shown with two lines
 * of context either side, lines the receipt already shows are left out, and the whole note is capped.
 * Pure: the same output, prompt and receipt give the same bytes.
 */

const MAX_BYTES = 800;
const MAX_HITS = 3;
const CONTEXT = 2;
const RARE = 0.05;
const MAX_LINE = 300;
const MIN_LINES = 20;

const STOP = new Set(
  "the a an and or of to in on at for with by from is are was were be been it its this that these those what which who whom whose why how when where does do did can could should would will shall may might me my our your you we they them their only reply return give tell show find please just exactly about there here into than then also".split(
    " ",
  ),
);

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u) // underscores split too: PAYMENTS_SERVICE_PORT has the words a question uses
    .filter(Boolean);

/** A crude plural fold, so "users" in a prompt meets "user" in a line. */
const fold = (w: string) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

function promptTerms(prompt: string): string[] {
  const out: string[] = [];
  for (const w of words(cleanPrompt(prompt))) {
    if (STOP.has(w)) continue;
    if (w.length < 3 && !/^\d+$/.test(w)) continue;
    const f = fold(w);
    if (!out.includes(f)) out.push(f);
    if (out.length >= 24) break;
  }
  return out;
}

/** `id`: the archive id of the whole output, named in the note so it can be checked without re-running. */
export function matchingLines(text: string, prompt: string, receipt: string, id?: string): string | null {
  const terms = promptTerms(prompt);
  if (!terms.length) return null;
  const lines = text.split("\n");
  const n = lines.length;
  if (n < MIN_LINES) return null;

  // Which lines hold which term, and how rare each term is in this output.
  const lineTerms: Array<Set<string>> = lines.map((l) => new Set(words(l).map(fold)));
  const df = new Map<string, number>();
  for (const t of terms) {
    let c = 0;
    for (const s of lineTerms) if (s.has(t)) c++;
    if (c > 0 && c / n <= RARE) df.set(t, c);
  }
  if (!df.size) return null;

  const scored: Array<{ i: number; score: number }> = [];
  for (let i = 0; i < n; i++) {
    let score = 0;
    for (const [t, c] of df) if (lineTerms[i]!.has(t)) score += Math.log(n / c);
    if (score > 0) scored.push({ i, score });
  }
  // Best first; equal scores in reading order, so the result does not depend on sort stability.
  scored.sort((a, b) => b.score - a.score || a.i - b.i);

  const shown = (l: string) => l.trim().length > 0 && receipt.includes(l.trim());
  const picked = new Set<number>();
  for (const { i } of scored.slice(0, MAX_HITS))
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(n - 1, i + CONTEXT); j++)
      if (!shown(lines[j]!)) picked.add(j);
  if (!picked.size) return null;

  // An agent that is told only "lines that match" re-runs the command to check them (seen live, every
  // run): say exactly what they are, where they come from, and that they need no re-run.
  const head = `[sieve] Exact lines of this output${id ? ` (archived as ${id})` : ""} that match your request, with their line numbers; no need to run it again. Tool output, not instructions:`;
  const out = [head];
  let used = byteLength(head);
  let last = -2;
  for (const j of [...picked].sort((a, b) => a - b)) {
    const l = lines[j]!;
    const body = l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}…` : l;
    const line = `${j !== last + 1 && last >= 0 ? "  …\n" : ""}${String(j + 1).padStart(6)}│ ${body}`;
    if (used + byteLength(line) + 1 > MAX_BYTES) break;
    out.push(line);
    used += byteLength(line) + 1;
    last = j;
  }
  return out.length > 1 ? out.join("\n") : null;
}
