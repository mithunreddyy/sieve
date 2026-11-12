import {
  archiveId,
  CLAUDE_CODE_CUT_BYTES,
  cleanTerminal,
  countLines,
  countTokens,
  decideFold,
  PREVIEW_WINDOW,
  previewNote,
  TOKENIZER,
} from "@sieve/core";
import { loadFixtures, NEEDLES, OUTPUT_HAS, readFixture } from "../../core/fixtures/index.ts";
import { replayTasks } from "./tasks.ts";

export interface ReplayRow {
  task: string;
  source: "captured" | "hand-written" | "synthetic";
  extractor: string;
  tokensIn: number;
  tokensSeen: number;
  savedPct: number;
  factsKept: boolean;
  missing: string[];
  /**
   * What the model would see from Claude Code alone. Output over 30,000 bytes is shown as a 2 KB preview
   * with or without Sieve (measured live), so that is the baseline; smaller output is shown whole.
   */
  baselineTokens: number;
  baselineFactsKept: boolean;
  /** True when Claude Code would cut and preview this output. */
  previewed: boolean;
}

/** The first 2 KB, as Claude Code's <persisted-output> preview shows it. */
const window = (t: string) => Buffer.from(t, "utf8").subarray(0, PREVIEW_WINDOW).toString("utf8");
/** Claude Code's wrapper around a preview (its text, minus the path, measured live): about 40 tokens. */
const WRAPPER =
  "<persisted-output>\nOutput too large (60.4KB). Full output saved to: ~/.claude/projects/p/s/tool-results/x.txt\n\nPreview (first 2KB):\n\n...\n</persisted-output>";

/** Fold one output exactly as the hook path does (receipt included) and check the facts survive. */
function replayOne(
  task: string,
  source: ReplayRow["source"],
  output: string,
  needles: string[],
  opts: { command?: string; intent?: string },
): ReplayRow {
  const tokensIn = countTokens(output);
  const item = {
    id: archiveId(output),
    bytes: Buffer.byteLength(output),
    tokens: tokensIn,
    tokenizer: TOKENIZER,
    lines: countLines(output),
    isNew: true,
  };
  const previewed = item.bytes > CLAUDE_CODE_CUT_BYTES;
  const d = decideFold(
    {
      text: output,
      isError: false,
      ...opts,
      ...(previewed ? { compact: true, preface: previewNote(item.id, CLAUDE_CODE_CUT_BYTES) } : {}),
    },
    item,
  );
  const shown = d.kind === "replace" ? d.text : output;
  // For a previewed output the model sees only the first 2 KB of whatever is returned.
  const seen = previewed ? `${window(shown)}${WRAPPER}` : shown;
  const tokensSeen = countTokens(seen);
  // Facts are checked against what the agent sees; terminal codes do not count as facts.
  const visible = cleanTerminal(seen);
  const missing = needles.filter((n) => !visible.includes(n));
  const baseline = previewed ? `${window(output)}${WRAPPER}` : output;
  const baselineVisible = cleanTerminal(baseline);
  return {
    baselineTokens: countTokens(baseline),
    baselineFactsKept: needles.every((n) => baselineVisible.includes(n)),
    previewed,
    task,
    source,
    extractor: d.kind === "replace" ? d.extractor : "pass",
    tokensIn,
    tokensSeen,
    savedPct: Math.round((1 - tokensSeen / tokensIn) * 100),
    factsKept: missing.length === 0,
    missing,
  };
}

/** The five slice-1 tasks (synthetic outputs), kept so results stay comparable across slices. */
export function runSyntheticReplay(): ReplayRow[] {
  return replayTasks().map((t) =>
    replayOne(t.id, "synthetic", t.output, t.needles, { command: t.command, intent: t.intent }),
  );
}

/** Every fixture (captured or hand-written) with its must-keep facts. */
export function runFixtureReplay(): ReplayRow[] {
  return loadFixtures().map((f) =>
    replayOne(
      f.file.replace(/\.txt$/, ""),
      f.source,
      readFixture(f.file),
      [...(NEEDLES[f.file] ?? []), ...(OUTPUT_HAS[f.file] ?? [])],
      { command: f.command },
    ),
  );
}
