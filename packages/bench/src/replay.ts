import { archiveId, cleanTerminal, countLines, countTokens, decideFold, TOKENIZER } from "@sieve/core";
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
}

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
  const d = decideFold({ text: output, isError: false, ...opts }, item);
  const seen = d.kind === "replace" ? d.text : output;
  const tokensSeen = countTokens(seen);
  // Facts are checked against what the agent sees; terminal codes do not count as facts.
  const visible = cleanTerminal(seen);
  const missing = needles.filter((n) => !visible.includes(n));
  return {
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
