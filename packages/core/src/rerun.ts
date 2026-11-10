import { boundedDiff } from "./boundeddiff.ts";
import { candidates, type ExtractInput } from "./extract/index.ts";
import type { ArchivedItem } from "./store.ts";
import { byteLength, cleanTerminal, formatInt } from "./text.ts";

/** Same command, normalised: surrounding space trimmed, runs of whitespace collapsed. */
export const commandKey = (cmd: string) => cmd.trim().replace(/\s+/g, " ");

export interface PreviousRun {
  runNo: number;
  item: ArchivedItem;
  text: string;
}

export type RerunResult =
  | { kind: "identical"; text: string }
  | { kind: "diff"; text: string }
  | { kind: "summary"; preface: string }
  | { kind: "none" };

/**
 * Compare a rerun with the previous run of the same command by the same reader in the same
 * epoch. Deterministic in (this output, the previous output): the one documented exception
 * to "depends only on the input bytes" (ADR 0003).
 * - identical bytes: a one-line receipt pointing at the earlier run
 * - an extractor that knows failure keys (tests, diagnostics): a fixed / new / still list
 * - otherwise, when the change is small: only the changed lines
 */
export function compareRuns(
  prev: PreviousRun,
  item: ArchivedItem,
  text: string,
  input: Omit<ExtractInput, "text" | "budget">,
): RerunResult {
  const ref = `run #${prev.runNo} of this command (${prev.item.id})`;
  if (prev.item.id === item.id) {
    return {
      kind: "identical",
      text: `[sieve ${item.id}] Same output as ${ref}, byte for byte (${formatInt(item.tokens)} tokens, ${input.isError ? "including its errors" : "nothing changed"}). It is still in your context, so it was not repeated. Expand: sieve_get {"id":"${item.id}"}`,
    };
  }
  const a = cleanTerminal(prev.text);
  const b = cleanTerminal(text);
  const ex = candidates({ ...input, text: b, budget: 16 * 1024 }).find((c) => c.ex.keys)?.ex;
  if (ex?.keys) {
    const before = new Set(ex.keys({ ...input, text: a, budget: 0 }));
    const after = new Set(ex.keys({ ...input, text: b, budget: 0 }));
    const fixed = [...before].filter((k) => !after.has(k));
    const added = [...after].filter((k) => !before.has(k));
    const still = [...after].filter((k) => before.has(k));
    const head = `vs ${ref}: ${fixed.length} fixed, ${added.length} new, ${still.length} still failing`;
    const list = (label: string, xs: string[]) =>
      xs.length
        ? [`  ${label}: ${xs.slice(0, 10).join(" · ")}${xs.length > 10 ? ` · … ${xs.length - 10} more` : ""}`]
        : [];
    return { kind: "summary", preface: [head, ...list("fixed", fixed), ...list("new", added)].join("\n") };
  }
  // Bounded: a large change is detected in O(n) and never diffed (Myers is O(N·D)).
  const d = boundedDiff(a, b, 0.3, 1);
  if (d?.body && byteLength(d.body) <= Math.min(byteLength(b) * 0.3, 8 * 1024)) {
    const { body, add, del } = d;
    return {
      kind: "diff",
      text: `[sieve ${item.id}] Changed since ${ref}: +${add} −${del} lines. Only the changes are shown (line numbers of the new output).\n${body}\nFull output: sieve_get {"id":"${item.id}"} · previous: sieve_get {"id":"${prev.item.id}"}`,
    };
  }
  return { kind: "none" };
}
