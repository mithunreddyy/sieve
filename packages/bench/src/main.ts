import { readFileSync } from "node:fs";
import { AGENTS, runAgentE2E } from "./agent-e2e.ts";
import { runLatency } from "./latency.ts";
import { loadRecords, renderMatrix } from "./matrix.ts";
import { analysePaired, renderPaired } from "./paired.ts";
import { runReadBench } from "./reads.ts";
import { type ReplayRow, runFixtureReplay, runSyntheticReplay } from "./replay.ts";
import { runRerankEval } from "./rerank.ts";

const which = process.argv[2] ?? "all";
let failed = false;

function table(rows: ReplayRow[], withSource: boolean) {
  console.log(
    `| output |${withSource ? " source |" : ""} extractor | output tokens | Claude Code alone | with Sieve | saved vs Claude Code | facts kept (alone / Sieve) |`,
  );
  console.log(`|---|${withSource ? "---|" : ""}---|---:|---:|---:|---:|---|`);
  for (const r of rows) {
    const facts = `${r.baselineFactsKept ? "yes" : "no"} / ${r.factsKept ? "yes" : `**no**: missing ${r.missing.map((m) => `\`${m}\``).join(", ")}`}`;
    const saved = Math.round((1 - r.tokensSeen / r.baselineTokens) * 100);
    console.log(
      `| ${r.task} |${withSource ? ` ${r.source} |` : ""} ${r.extractor}${r.previewed ? " (2 KB preview)" : ""} | ${r.tokensIn} | ${r.baselineTokens} | ${r.tokensSeen} | ${saved}% | ${facts} |`,
    );
  }
  const base = rows.reduce((n, r) => n + r.baselineTokens, 0);
  const tout = rows.reduce((n, r) => n + r.tokensSeen, 0);
  const lost = rows.filter((r) => !r.factsKept).length;
  const lostAlone = rows.filter((r) => !r.baselineFactsKept).length;
  // Fails the gate: a fact Sieve's view loses that Claude Code alone would have shown.
  const worse = rows.filter((r) => !r.factsKept && r.baselineFactsKept).length;
  console.log(
    `\nTotal against what Claude Code alone shows: ${base} → ${tout} tokens (${Math.round((1 - tout / base) * 100)}% fewer). Facts lost: ${lostAlone} of ${rows.length} with Claude Code alone, ${lost} with Sieve; ${worse} where Sieve loses a fact Claude Code alone would have shown.\n`,
  );
  return worse;
}

if (which === "paired") {
  const file = process.argv[3];
  if (!file) {
    console.error("usage: bun run bench paired <results.json>   (see docs/bench-protocol.md)");
    process.exit(2);
  }
  console.log(renderPaired(analysePaired(JSON.parse(readFileSync(file, "utf8")))));
  process.exit(0);
}
if (which === "rerank") {
  console.log(JSON.stringify(runRerankEval(), null, 2));
  process.exit(0);
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
  const large = rows.filter((r) => r.case.startsWith("go shim, large"));
  failed = warm.some((r) => r.p99 > 30) || large.some((r) => r.p99 > 200);
  console.log(
    `\nRelease gate (warm go shim p99 ≤ 30 ms; large results kept in a file p99 ≤ 200 ms, under the 250 ms hook timeout): ${failed ? "FAIL" : "pass"}`,
  );
}

// Output piped into a reader that stops early (`| head`, `| tail`) must end the run quietly,
// not as an unhandled EPIPE stack trace.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

if (which === "matrix") {
  // bun run bench matrix : write docs/support-matrix.md from the adapters and docs/e2e/*.json
  const text = renderMatrix(loadRecords("docs/e2e"));
  await Bun.write("docs/support-matrix.md", text);
  console.log(text);
}

if (which === "agent-e2e") {
  // bun run bench agent-e2e <agent|all> [--run] : the real-agent check (spends one model call per agent with --run)
  const want = process.argv[3] ?? "all";
  const run = process.argv.includes("--run");
  const chosen = AGENTS.filter((a) => want === "all" || a.agent === want);
  if (!chosen.length) {
    console.error(`unknown agent ${want}; known: ${AGENTS.map((a) => a.agent).join(", ")}`);
    process.exit(2);
  }
  for (const a of chosen) {
    const r = await runAgentE2E(a, { run, record: run ? "docs/e2e" : undefined });
    if (r && !r.passed) failed = true;
  }
}

console.log(failed ? "\nBench gate: FAIL" : "\nBench gate: pass");
process.exit(failed ? 1 : 0);
