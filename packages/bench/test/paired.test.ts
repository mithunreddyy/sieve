import { describe, expect, test } from "bun:test";
import { analysePaired, binomialUpperTail, type RunResult, renderPaired } from "../src/paired.ts";

const runs = (
  task: string,
  n: number,
  base: number,
  sieve: number,
  bOk: boolean[],
  sOk: boolean[],
): RunResult[] =>
  Array.from({ length: n }, (_, i) => [
    { task, arm: "baseline" as const, run: i, success: bOk[i % bOk.length]!, uncachedInputTokens: base },
    { task, arm: "sieve" as const, run: i, success: sOk[i % sOk.length]!, uncachedInputTokens: sieve },
  ]).flat();

describe("statistics", () => {
  test("the exact binomial tail", () => {
    expect(binomialUpperTail(10, 0)).toBe(1);
    expect(binomialUpperTail(10, 11)).toBe(0);
    expect(binomialUpperTail(10, 10)).toBeCloseTo(1 / 1024, 10);
    expect(binomialUpperTail(10, 5)).toBeCloseTo(0.623046875, 9);
    expect(binomialUpperTail(0, 0)).toBe(1);
  });
});

describe("the paired analysis", () => {
  test("a clear win: big reduction, same success", () => {
    const r = analysePaired([
      ...runs("a", 20, 100_000, 30_000, [true], [true]),
      ...runs("b", 20, 80_000, 35_000, [true, false], [true, false]),
    ]);
    expect(r.pairs).toBe(40);
    expect(r.reductionPct).toBeCloseTo((1 - 65 / 180) * 100, 0);
    expect(r.ci95[0]).toBeGreaterThan(50);
    expect(r.success.onlyBaseline).toBe(0);
    expect(r.noSignificantDrop).toBe(true);
    expect(r.meetsTarget).toBe(true);
    expect(renderPaired(r)).toContain("is met");
  });

  test("a saving with a real success drop does not meet the target", () => {
    const r = analysePaired(runs("a", 30, 100_000, 20_000, [true], [false, false, true]));
    expect(r.success.onlyBaseline).toBe(20);
    expect(r.noSignificantDrop).toBe(false);
    expect(r.meetsTarget).toBe(false);
    expect(renderPaired(r)).toContain("a significant drop");
  });

  test("a point estimate over 50% is not enough if the interval reaches below it", () => {
    // 4 pairs: one task barely helped, so the interval is wide
    const r = analysePaired([
      ...runs("big", 2, 100_000, 20_000, [true], [true]),
      ...runs("small", 2, 100_000, 95_000, [true], [true]),
    ]);
    expect(r.reductionPct).toBeCloseTo(42.5, 1);
    expect(r.meetsTarget).toBe(false);
    expect(r.warnings.join(" ")).toContain("only 4 pair");
  });

  test("tasks that did not help are named, worst first", () => {
    const r = analysePaired([
      ...runs("helped", 10, 100_000, 20_000, [true], [true]),
      ...runs("flat", 10, 50_000, 49_000, [true], [true]),
    ]);
    expect(r.tasks[0]!.task).toBe("flat");
    expect(r.tasks[0]!.helped).toBe(false);
    expect(renderPaired(r)).toContain("Tasks where Sieve saved under 10%: flat.");
    expect(renderPaired(r)).toContain("**did not help**");
  });

  test("runs without a partner are left out and said so; the same data gives the same interval", () => {
    const data = [
      ...runs("a", 10, 100_000, 40_000, [true], [true]),
      { task: "a", arm: "sieve" as const, run: 99, success: true, uncachedInputTokens: 1 },
    ];
    const r1 = analysePaired(data);
    const r2 = analysePaired(data);
    expect(r1.warnings.join(" ")).toContain("1 run(s) had no partner");
    expect(r1.pairs).toBe(10);
    expect(r2.ci95).toEqual(r1.ci95);
  });

  test("no data says so instead of inventing a number", () => {
    expect(renderPaired(analysePaired([]))).toContain("No paired runs were found.");
  });
});
