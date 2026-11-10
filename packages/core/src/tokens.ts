import { getEncoding, type Tiktoken } from "js-tiktoken";

export const TOKENIZER = "o200k_base";

let enc: Tiktoken | undefined;

/** Load the tokenizer now (the daemon calls this at start so hooks never pay for it). */
export function warmTokenizer(): void {
  enc ??= getEncoding(TOKENIZER);
}

/**
 * Real token count with a real BPE tokenizer, not a bytes/3 estimate. Long inputs are
 * counted in line-aligned slices so a single huge string never stalls the encoder; the
 * slicing is deterministic, so the count for a given input never changes.
 */
export function countTokens(text: string): number {
  warmTokenizer();
  const SLICE = 64 * 1024;
  if (text.length <= SLICE) return enc!.encode(text, [], []).length;
  let total = 0;
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + SLICE, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > i) end = nl + 1;
    }
    total += enc!.encode(text.slice(i, end), [], []).length;
    i = end;
  }
  return total;
}
