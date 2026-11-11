/**
 * The paired benchmark's analysis (slice 12). It reads the results of running the SAME tasks with
 * and without Sieve and says what happened: how many fewer uncached input tokens, whether task
 * success dropped, and which tasks Sieve did not help.
 *
 * This file is the statistics and the report. It does not run agents: producing the results needs
 * real agent sessions against a real model, which cost money and need credentials. See
 * docs/bench-protocol.md for how to produce them, and note that until someone has, no published
 * number exists. The tests here feed it synthetic data to check the arithmetic.
 *
 * Method, so the claim can be checked:
 *  - Pairing: run k of task T without Sieve is paired with run k of T with it.
 *  - Tokens: the statistic is the ratio sum(sieve uncached input) / sum(baseline uncached input) over
 *    all pairs; the 95% interval comes from a bootstrap over pairs (10,000 resamples, seeded).
 *  - Success: an exact one-sided McNemar (binomial) test of "Sieve fails where the baseline succeeds
 *    more often than the reverse". "No significant drop" means p >= 0.05 on that test. A small sample
 *    can fail to detect a real drop; the report prints the counts so the reader can see how much
 *    evidence there is.
 */

export interface RunResult {
  task: string;
  arm: "baseline" | "sieve";
  /** 0-based repetition of the task within the arm. */
  run: number;
  success: boolean;
  /** Input tokens that were not served from the provider's prompt cache, summed over the session. */
  uncachedInputTokens: number;
  outputTokens?: number;
}

export interface TaskRow {
  task: string;
  pairs: number;
  baselineTokens: number;
  sieveTokens: number;
  reductionPct: number;
  baselineSuccess: number;
  sieveSuccess: number;
  helped: boolean;
}

export interface PairedReport {
  pairs: number;
  /** 1 - ratio, as a percentage. */
  reductionPct: number;
  ci95: [number, number];
  success: { baseline: number; sieve: number; onlyBaseline: number; onlySieve: number; pValueWorse: number };
  noSignificantDrop: boolean;
  meetsTarget: boolean;
  tasks: TaskRow[];
  warnings: string[];
}

/** mulberry32: a small seeded generator, so a report is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** P(X >= k) for X ~ Binomial(n, 0.5), exactly. */
export function binomialUpperTail(n: number, k: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  // sum C(n,i) / 2^n for i >= k, in log space to stay finite for large n
  const lf = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= n; i++) lf[i] = (lf[i - 1] ?? 0) + Math.log(i);
  let p = 0;
  for (let i = k; i <= n; i++) p += Math.exp((lf[n] ?? 0) - (lf[i] ?? 0) - (lf[n - i] ?? 0) - n * Math.LN2);
  return Math.min(1, p);
}

export function analysePaired(
  results: RunResult[],
  opts: { target?: number; resamples?: number; seed?: number } = {},
): PairedReport {
  const target = opts.target ?? 50;
  const warnings: string[] = [];
  const key = (r: RunResult) => `${r.task}\u0000${r.run}`;
  const base = new Map(results.filter((r) => r.arm === "baseline").map((r) => [key(r), r]));
  const sieve = new Map(results.filter((r) => r.arm === "sieve").map((r) => [key(r), r]));
  const pairs: Array<{ b: RunResult; s: RunResult }> = [];
  for (const [k, b] of base) {
    const s = sieve.get(k);
    if (s) pairs.push({ b, s });
  }
  const unpaired = base.size + sieve.size - 2 * pairs.length;
  if (unpaired) warnings.push(`${unpaired} run(s) had no partner in the other arm and were left out`);
  if (pairs.length < 30)
    warnings.push(
      `only ${pairs.length} pair(s): the interval is wide and a real drop in success could go undetected`,
    );

  const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0);
  const ratio = (ps: typeof pairs) => {
    const b = sum(ps.map((p) => p.b.uncachedInputTokens));
    return b === 0 ? 1 : sum(ps.map((p) => p.s.uncachedInputTokens)) / b;
  };
  const point = (1 - ratio(pairs)) * 100;

  // bootstrap over pairs
  const rand = rng(opts.seed ?? 20261111);
  const n = opts.resamples ?? 10_000;
  const draws: number[] = [];
  if (pairs.length) {
    for (let i = 0; i < n; i++) {
      const re = Array.from({ length: pairs.length }, () => pairs[Math.floor(rand() * pairs.length)]!);
      draws.push((1 - ratio(re)) * 100);
    }
    draws.sort((a, b) => a - b);
  }
  const ci: [number, number] = draws.length
    ? [draws[Math.floor(0.025 * n)]!, draws[Math.floor(0.975 * n)]!]
    : [0, 0];

  let onlyBase = 0;
  let onlySieve = 0;
  for (const { b, s } of pairs) {
    if (b.success && !s.success) onlyBase++;
    if (!b.success && s.success) onlySieve++;
  }
  const discordant = onlyBase + onlySieve;
  const pWorse = binomialUpperTail(discordant, onlyBase);

  const byTask = new Map<string, typeof pairs>();
  for (const p of pairs) byTask.set(p.b.task, [...(byTask.get(p.b.task) ?? []), p]);
  const tasks: TaskRow[] = [...byTask].map(([task, ps]) => {
    const bt = sum(ps.map((p) => p.b.uncachedInputTokens));
    const st = sum(ps.map((p) => p.s.uncachedInputTokens));
    const red = bt ? (1 - st / bt) * 100 : 0;
    return {
      task,
      pairs: ps.length,
      baselineTokens: bt,
      sieveTokens: st,
      reductionPct: Math.round(red * 10) / 10,
      baselineSuccess: ps.filter((p) => p.b.success).length,
      sieveSuccess: ps.filter((p) => p.s.success).length,
      helped: red >= 10,
    };
  });
  tasks.sort((a, b) => a.reductionPct - b.reductionPct);

  return {
    pairs: pairs.length,
    reductionPct: Math.round(point * 10) / 10,
    ci95: [Math.round(ci[0] * 10) / 10, Math.round(ci[1] * 10) / 10],
    success: {
      baseline: pairs.filter((p) => p.b.success).length,
      sieve: pairs.filter((p) => p.s.success).length,
      onlyBaseline: onlyBase,
      onlySieve: onlySieve,
      pValueWorse: Math.round(pWorse * 10000) / 10000,
    },
    noSignificantDrop: pWorse >= 0.05,
    // The target needs the whole interval, not just the point estimate, to clear it.
    meetsTarget: pairs.length > 0 && ci[0] >= target && pWorse >= 0.05,
    tasks,
    warnings,
  };
}

export function renderPaired(r: PairedReport, target = 50): string {
  const L: string[] = [];
  L.push("# Paired benchmark: with and without Sieve", "");
  if (!r.pairs) return `${L.join("\n")}No paired runs were found.\n`;
  L.push(
    `Pairs: ${r.pairs}. Uncached input tokens: **${r.reductionPct}% fewer** (95% interval ${r.ci95[0]}% to ${r.ci95[1]}%).`,
    `Task success: baseline ${r.success.baseline}/${r.pairs}, with Sieve ${r.success.sieve}/${r.pairs}. Only the baseline succeeded in ${r.success.onlyBaseline} pair(s); only Sieve in ${r.success.onlySieve}. One-sided exact test that Sieve is worse: p = ${r.success.pValueWorse} (${r.noSignificantDrop ? "no significant drop" : "**a significant drop**"}).`,
    "",
    r.meetsTarget
      ? `The v1.0 target (at least ${target}% fewer uncached input tokens with no significant drop in success) is met: the whole interval is above ${target}%.`
      : `The v1.0 target (at least ${target}% fewer uncached input tokens with no significant drop in success) is **not** shown to be met.`,
    "",
  );
  for (const w of r.warnings) L.push(`> ${w}`);
  if (r.warnings.length) L.push("");
  L.push(
    "| task | pairs | baseline tokens | with Sieve | reduction | success (base → Sieve) | |",
    "|---|---:|---:|---:|---:|---|---|",
  );
  for (const t of r.tasks)
    L.push(
      `| ${t.task} | ${t.pairs} | ${t.baselineTokens.toLocaleString("en-US")} | ${t.sieveTokens.toLocaleString("en-US")} | ${t.reductionPct}% | ${t.baselineSuccess}/${t.pairs} → ${t.sieveSuccess}/${t.pairs} | ${t.helped ? "" : "**did not help**"} |`,
    );
  const none = r.tasks.filter((t) => !t.helped);
  L.push(
    "",
    none.length
      ? `Tasks where Sieve saved under 10%: ${none.map((t) => t.task).join(", ")}.`
      : "Sieve saved at least 10% on every task.",
  );
  return `${L.join("\n")}\n`;
}
