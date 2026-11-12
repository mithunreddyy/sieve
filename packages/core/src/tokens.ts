import { getEncoding, type Tiktoken } from "js-tiktoken";

export const TOKENIZER = "o200k_base";

let enc: Tiktoken | undefined;

/** Load the tokenizer now (the daemon calls this at start so hooks never pay for it). */
export function warmTokenizer(): void {
  enc ??= getEncoding(TOKENIZER);
}

/**
 * What is quadratic is ONE giant pre-token: the tokenizer first splits text into pre-tokens (a run of
 * letters of one case, a run of punctuation or symbols, a run of whitespace, digits in threes), and
 * merges each pre-token on its own, in time quadratic in its length. Ordinary text, minified code,
 * compact JSON and base64 split into short pre-tokens and were never slow. These four shapes of 256 or
 * more characters are the giants (measured: 30,000 of any of them took 20-39 s).
 */
const LOWER = "\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}";
const UPPER = "\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}";
const GIANT_SRC = `[${LOWER}]{256,}|[${UPPER}]{256,}|[^\\s\\p{L}\\p{N}]{256,}|\\s{256,}`;
// Two regexes on purpose: .test() on a global one moves its lastIndex, and matchAll clones that position.
const HAS_GIANT = new RegExp(GIANT_SRC.replaceAll("{256,}", "{256}"), "u");
const GIANT = new RegExp(GIANT_SRC, "gu");
const RUN_PIECE = 128;

/** Tokens in one giant run: pieces of 128 below 4,096 characters, an estimate from 8 sampled pieces above. */
function runTokens(run: string): number {
  const pieces = Math.ceil(run.length / RUN_PIECE);
  const count = (at: number) => enc!.encode(run.slice(at, at + RUN_PIECE), [], []).length;
  if (run.length < 4096) {
    let t = 0;
    for (let i = 0; i < run.length; i += RUN_PIECE) t += count(i);
    return t;
  }
  let sum = 0;
  for (let k = 0; k < 8; k++) sum += count(Math.floor((k * (pieces - 1)) / 7) * RUN_PIECE);
  return Math.round((sum / 8) * pieces);
}

/**
 * Count one piece of text. Exact, unless it holds a giant pre-token (see GIANT_SRC): such a run is
 * counted in pieces of 128 characters, and one of 4,096 or more is estimated from 8 sampled pieces
 * (deterministic, so receipts stay pure functions). Everything else is exactly the real tokenizer's count.
 */
function encodeCount(text: string): number {
  if (!HAS_GIANT.test(text)) return enc!.encode(text, [], []).length;
  let total = 0;
  let last = 0;
  for (const m of text.matchAll(GIANT)) {
    total += enc!.encode(text.slice(last, m.index), [], []).length;
    total += runTokens(m[0]);
    last = m.index + m[0].length;
  }
  return total + enc!.encode(text.slice(last), [], []).length;
}

/**
 * Real token count with a real BPE tokenizer, not a bytes/3 estimate. Long inputs are
 * counted in line-aligned slices so a single huge string never stalls the encoder; the
 * slicing is deterministic, so the count for a given input never changes.
 */
export function countTokens(text: string): number {
  warmTokenizer();
  const SLICE = 64 * 1024;
  if (text.length <= SLICE) return encodeCount(text);
  let total = 0;
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + SLICE, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > i) end = nl + 1;
    }
    total += encodeCount(text.slice(i, end));
    i = end;
  }
  return total;
}
