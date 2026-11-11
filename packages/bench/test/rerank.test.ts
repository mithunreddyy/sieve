import { describe, expect, test } from "bun:test";
import { runRerankEval } from "../src/rerank.ts";

describe("reranker evaluation", () => {
  test("report the numbers, and do not ship a reranker that makes recall@3 worse", () => {
    const r = runRerankEval();
    console.log(
      `rerank eval: ${r.queries} queries | off @1 ${r.off.at1} @3 ${r.off.at3} | hash @1 ${r.hash.at1} @3 ${r.hash.at3}`,
    );
    for (const c of r.changed) console.log(`  changed: "${c.query}" off=${c.off} hash=${c.hash}`);
    expect(r.hash.at3).toBeGreaterThanOrEqual(r.off.at3);
  });
});
