import { runLatency } from "./latency.ts";
import { runReadBench } from "./reads.ts";
import { type ReplayRow, runFixtureReplay, runSyntheticReplay } from "./replay.ts";

const which = process.argv[2] ?? "all";
let failed = false;

function table(rows: ReplayRow[], withSource: boolean) {
  console.log(
    `| output |${withSource ? " source |" : ""} extractor | tokens in | tokens seen | saved | facts kept |`,
  );
  console.log(`|---|${withSource ? "---|" : ""}---|---:|---:|---:|---|`);
  for (const r of rows) {
    const facts = r.factsKept ? "yes" : `**no**: missing ${r.missing.map((m) => `\`${m}\``).join(", ")}`;
    console.log(
      `| ${r.task} |${withSource ? ` ${r.source} |` : ""} ${r.extractor} | ${r.tokensIn} | ${r.tokensSeen} | ${r.savedPct}% | ${facts} |`,
    );
  }
  const tin = rows.reduce((n, r) => n + r.tokensIn, 0);
  const tout = rows.reduce((n, r) => n + r.tokensSeen, 0);
  const lost = rows.filter((r) => !r.factsKept).length;
  console.log(
    `\nTotal: ${tin} → ${tout} tokens (${Math.round((1 - tout / tin) * 100)}% fewer); ${lost} of ${rows.length} lost a fact.\n`,
  );
  return lost;
}

if (which === "replay" || which === "all") {
  console.log(
    "## Replay: real tool output through the hook-path fold (receipt included; tokens: o200k_base)\n",
  );
  console.log(
    "Facts are checked in what the agent sees. A row that saves tokens but loses a fact is a loss.\n",
  );
  // Release gate: any lost fact on real output fails the run (prompt.md §13).
  if (table(runFixtureReplay(), true) > 0) failed = true;
  console.log("## Replay: the five slice-1 synthetic tasks (for comparison across slices)\n");
  table(runSyntheticReplay(), false);
}

if (which === "reads" || which === "all") {
  console.log("## Smart reads: first full read of large real source files (installed dependencies)\n");
  console.log(
    'The intent names a top-level symbol from the middle of the file; "found" means its lines are in the outline reply.\n',
  );
  console.log("| file | tokens | outline reply | saved | symbols | asked for | found |");
  console.log("|---|---:|---:|---:|---:|---|---|");
  const rows = await runReadBench();
  for (const r of rows)
    console.log(
      `| ${r.file} | ${r.tokens} | ${r.outlineTokens} | ${r.savedPct}% | ${r.symbols} | ${r.target} | ${r.found ? "yes" : "**no**"} |`,
    );
  const t = rows.reduce((n, r) => n + r.tokens, 0);
  const o = rows.reduce((n, r) => n + r.outlineTokens, 0);
  console.log(
    `\nTotal: ${t} → ${o} tokens on first read (${Math.round((1 - o / t) * 100)}% fewer); found ${rows.filter((r) => r.found).length} of ${rows.length}. An agent that needs the whole file reads again and pays the full cost plus the outline.\n`,
  );
}

if (which === "latency" || which === "all") {
  console.log("## Hook latency, end to end (exec → stdout), this machine\n");
  console.log("| case | n | replied | p50 ms | p99 ms | max ms |");
  console.log("|---|---:|---:|---:|---:|---:|");
  const rows = await runLatency(Number(process.env.BENCH_N ?? 300));
  for (const r of rows) console.log(`| ${r.case} | ${r.n} | ${r.replied} | ${r.p50} | ${r.p99} | ${r.max} |`);
  const warm = rows.filter((r) => r.case.startsWith("go shim, warm"));
  failed = warm.some((r) => r.p99 > 30);
  console.log(`\nRelease gate (warm go shim p99 ≤ 30 ms): ${failed ? "FAIL" : "pass"}`);
}

console.log(failed ? "\nBench gate: FAIL" : "\nBench gate: pass");
process.exit(failed ? 1 : 0);
