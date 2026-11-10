import { ERROR_LINE } from "../errors.ts";
import { byteLength } from "../text.ts";
import { DIAGNOSTIC_EXTRACTORS } from "./diagnostics.ts";
import { GIT_EXTRACTORS } from "./git.ts";
import { html } from "./html.ts";
import { json } from "./json.ts";
import { logs } from "./logs.ts";
import { pkg } from "./packages.ts";
import { searchResults } from "./search.ts";
import { TEST_EXTRACTORS } from "./tests.ts";
import type { ExtractInput, Extraction, Extractor } from "./types.ts";

export { htmlToMarkdown } from "./html.ts";
export type { ExtractInput, Extraction, Extractor } from "./types.ts";

/** Registry order breaks detection ties: specific formats before generic ones. */
export const EXTRACTORS: Extractor[] = [
  ...TEST_EXTRACTORS,
  ...DIAGNOSTIC_EXTRACTORS,
  ...GIT_EXTRACTORS,
  pkg,
  json,
  html,
  searchResults,
  logs,
];

/** Below this confidence an extractor is not used. */
export const MIN_CONFIDENCE = 50;

/** Candidates in the order they will be tried. Deterministic. */
export function candidates(input: ExtractInput): Array<{ ex: Extractor; score: number }> {
  return EXTRACTORS.map((ex, i) => ({ ex, i, score: ex.detect(input) }))
    .filter((c) => c.score >= MIN_CONFIDENCE)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(({ ex, score }) => ({ ex, score }));
}

/**
 * Run the best extractor that parses the input. If its body is over budget it is cut at a
 * whole line, except that bodies with kept failures may grow to 3× the budget, and any
 * error lines past the cut are still listed (errors are never cut).
 */
export function runExtractors(input: ExtractInput): Extraction | null {
  for (const { ex } of candidates(input)) {
    const r = ex.extract(input);
    if (!r?.body.trim()) continue;
    const limit = r.keptVerbatim ? input.budget * 3 : input.budget;
    if (byteLength(r.body) <= limit) return r;
    const ls = r.body.split("\n");
    const keep: string[] = [];
    let used = 0;
    let i = 0;
    for (; i < ls.length && used + byteLength(ls[i]!) + 1 <= limit; i++) {
      keep.push(ls[i]!);
      used += byteLength(ls[i]!) + 1;
    }
    const errs = ls
      .slice(i)
      .filter((l) => ERROR_LINE.test(l))
      .slice(0, 60);
    keep.push(
      `… extractor output cut at ${Math.round(limit / 1024)} KB (${ls.length - i} more lines in the archive)`,
    );
    if (errs.length)
      keep.push("error lines after the cut:", ...errs.map((l) => `  ${l.trim().slice(0, 300)}`));
    return {
      ...r,
      body: keep.join("\n"),
      dropped: [...r.dropped, `${ls.length - i} lines past the ${Math.round(limit / 1024)} KB budget`],
    };
  }
  return null;
}
