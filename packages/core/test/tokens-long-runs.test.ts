import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getEncoding } from "js-tiktoken";
import { countTokens } from "../src/index.ts";

/**
 * BPE tokenizing is quadratic in the length of ONE giant pre-token: a run of spaces, of newlines, of
 * same-case letters, or of punctuation or symbols. Measured on the daemon's single thread: 30,000 of any
 * of them took 20-39 s, for every agent, because every output is counted (store.put). Ordinary text,
 * minified code, compact JSON and base64 split into short pre-tokens and were never slow, so their
 * counts must not move at all (ADR 0021).
 */

/** The algorithm before the fix: 64 KB line-aligned slices, each counted exactly. */
function reference(text: string): number {
  const enc = getEncoding("o200k_base");
  const SLICE = 64 * 1024;
  if (text.length <= SLICE) return enc.encode(text, [], []).length;
  let total = 0;
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + SLICE, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > i) end = nl + 1;
    }
    total += enc.encode(text.slice(i, end), [], []).length;
    i = end;
  }
  return total;
}

const issues = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/json/github-issues.txt"), "utf8"));

describe("giant pre-tokens are counted quickly", () => {
  test.each([
    ["30,000 spaces", " ".repeat(30_000)],
    ["30,000 newlines", "\n".repeat(30_000)],
    ["30,000 × a", "a".repeat(30_000)],
    ["30,000 × A", "A".repeat(30_000)],
    ["12,000 × ✓", "✓".repeat(12_000)],
    ["a 100 KB rule", "=".repeat(100_000)],
    ["a giant run between normal text", `before ${"x".repeat(50_000)} after`],
    ["blank lines inside a log", `start\n${"\n".repeat(20_000)}end`],
  ])("%s", (_name, text) => {
    const t0 = performance.now();
    const n = countTokens(text);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(n).toBeGreaterThan(0);
  });

  test("a count is deterministic and grows with the input, also for a giant", () => {
    const a = countTokens("a".repeat(30_000));
    expect(countTokens("a".repeat(30_000))).toBe(a);
    expect(countTokens("a".repeat(60_000))).toBeGreaterThan(a);
  });

  // The reference is the real tokenizer, which is itself quadratic on these: kept just over the 256-character
  // giant threshold so it stays fast on a slow CI machine (3,000 characters timed out there at 5 s).
  test("an estimate for a giant is close: within 10% of the real count", () => {
    for (const text of ["a".repeat(600), "✓".repeat(400), " ".repeat(600), "=".repeat(500)]) {
      const real = getEncoding("o200k_base").encode(text, [], []).length;
      expect(Math.abs(countTokens(text) - real) / real).toBeLessThan(0.1);
    }
  }, 30_000);
});

describe("what was never slow is counted exactly as before", () => {
  test.each([
    ["compact JSON, one 154 KB line (jq -c)", JSON.stringify(issues)],
    ["pretty JSON", JSON.stringify(issues, null, 2)],
    [
      "30 KB of base64",
      Buffer.from(Array.from({ length: 22_500 }, (_, i) => (i * 7919) % 256)).toString("base64"),
    ],
    ["30 KB of minified code", "function a(b){return b+1;}".repeat(1200)],
    ["30,000 characters of alternating case", "aA".repeat(15_000)],
    ["30,000 digits", "7".repeat(30_000)],
    ["a 40 KB hex dump", "deadbeef0123".repeat(3300)],
    [
      "ordinary lines",
      Array.from({ length: 3000 }, (_, i) => `line ${i} of some perfectly ordinary text`).join("\n"),
    ],
    ["short strings", "hello world"],
    ["empty", ""],
  ])("%s", (_name, text) => {
    expect(countTokens(text)).toBe(reference(text));
  });
});
