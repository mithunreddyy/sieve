import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPECTED, loadFixtures, NEEDLES, NOTHING_TO_FOLD, OUTPUT_HAS } from "../fixtures/index.ts";
import { candidates, cleanTerminal, runExtractors } from "../src/index.ts";

const FIX = join(import.meta.dir, "../fixtures");
const fixtures = loadFixtures();
const expectedFor = (file: string) => EXPECTED[file] ?? file.split("/")[0]!;

describe("fixtures", () => {
  test("manifest covers every fixture file and says where each came from", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(35);
    for (const f of fixtures) expect(["captured", "hand-written"]).toContain(f.source);
  });

  for (const f of fixtures) {
    describe(`${f.file} (${f.source})`, () => {
      const raw = readFileSync(join(FIX, f.file), "utf8");
      const input = { text: cleanTerminal(raw), command: f.command, isError: false, budget: 16 * 1024 };

      test(`detected as ${expectedFor(f.file)}`, () => {
        expect(candidates(input)[0]?.ex.id).toBe(expectedFor(f.file));
      });

      test("deterministic, keeps the facts, matches snapshot", () => {
        const a = runExtractors(input);
        const b = runExtractors(input);
        if (NOTHING_TO_FOLD.has(f.file)) {
          expect(a).toBeNull();
          return;
        }
        expect(a).not.toBeNull();
        expect(a).toEqual(b!);
        for (const n of NEEDLES[f.file] ?? []) {
          expect(raw).toContain(n); // the needle is real
          expect(a!.body).toContain(n);
        }
        for (const n of OUTPUT_HAS[f.file] ?? []) expect(a!.body).toContain(n);
        expect(a!.extractor).toBe(expectedFor(f.file));
        expect(a).toMatchSnapshot();
      });

      test("is still recognised without the command", () => {
        if (["search", "pkg"].includes(expectedFor(f.file))) return; // grep output and installs need the command for confidence
        const top = candidates({ ...input, command: "" })[0]?.ex.id;
        expect(top).toBe(expectedFor(f.file));
      });
    });
  }
});

describe("the budget cut never leaves an empty body", () => {
  test("an output whose first line alone is over the budget keeps the start of that line (found: a JSON receipt with no body at all)", () => {
    // npm view --json, as captured: the JSON extractor flattens it, so its first line is long
    const out = readFileSync(join(import.meta.dir, "../fixtures/json/npm-view.txt"), "utf8");
    const ex = runExtractors({ text: out, isError: false, budget: 768, command: "npm view zod --json" })!;
    const body = ex.body.split("\n");
    expect(body[0]!.length).toBeGreaterThan(200); // real content first, not just the cut notice
    expect(ex.body).toContain('"name": "zod"'); // the value, not just the key list
    expect(Buffer.byteLength(ex.body)).toBeLessThan(768 + 400);
    expect(ex.body).toContain("first line cut at");
  });
});

describe("repeats: any repetitive output, folded by line template, rare lines kept verbatim", () => {
  const testRun = Array.from({ length: 320 }, (_, i) =>
    i === 171
      ? "FAIL src/auth/token.test.ts > rejects an expired token: expected status 401, received 200"
      : `PASS src/module${i % 37}/case${i}.test.ts > handles input variant ${i} (${(i * 7) % 90} ms)`,
  ).join("\n");
  const config = (() => {
    const l = Array.from({ length: 520 }, (_, i) => `SERVICE_${i}_TIMEOUT_MS=${1000 + i}`);
    l.splice(311, 0, "PAYMENTS_SERVICE_PORT=8443");
    return l.join("\n");
  })();

  test("a test run in no known format: the one failure is in the receipt, the 319 passes are one line", () => {
    const ex = runExtractors({ text: testRun, isError: false, budget: 16 * 1024 })!;
    expect(ex.extractor).toBe("repeats");
    expect(ex.body).toContain(
      "L172: FAIL src/auth/token.test.ts > rejects an expired token: expected status 401, received 200",
    );
    expect(ex.body).toMatch(
      /319× PASS src\/module<n>\/case<n>\.test\.ts > handles input variant <n> \(<n> ms\)/,
    );
    expect(Buffer.byteLength(ex.body)).toBeLessThan(600);
  });

  test("a config dump: the one setting unlike the others is kept verbatim (words are kept, only numbers fold)", () => {
    const ex = runExtractors({ text: config, isError: false, budget: 16 * 1024 })!;
    expect(ex.extractor).toBe("repeats");
    expect(ex.body).toContain("L312: PAYMENTS_SERVICE_PORT=8443");
    expect(ex.body).toContain("520× SERVICE_<n>_TIMEOUT_MS=<n>");
  });

  test("repeated error lines are never folded away", () => {
    const l = Array.from({ length: 200 }, (_, i) =>
      i % 50 === 7 ? `error: request ${i} timed out after ${i} ms` : `ok request ${i} served in ${i} ms`,
    );
    const ex = runExtractors({ text: l.join("\n"), isError: false, budget: 16 * 1024 })!;
    for (const i of [7, 57, 107, 157])
      expect(ex.body).toContain(`error: request ${i} timed out after ${i} ms`);
  });

  test("text that does not repeat is left to the fallback", () => {
    const prose = Array.from(
      { length: 120 },
      (_, i) =>
        `${["alpha", "bravo", "charlie", "delta"][i % 4]} paragraph ${"word ".repeat(i % 7)}ends ${String.fromCharCode(97 + (i % 26))}`,
    ).join("\n");
    expect(
      candidates({ text: prose, isError: false, budget: 16 * 1024 }).some((c) => c.ex.id === "repeats"),
    ).toBe(false);
  });

  test("a known format still wins: real captured output keeps its own extractor", () => {
    for (const [file, id] of [
      ["logs/npm-silly.txt", "logs"],
      ["git/log.txt", "git-log"],
      ["biome/lint-repeated.txt", "biome"],
    ] as const) {
      const text = readFileSync(join(FIX, file), "utf8");
      expect(runExtractors({ text, isError: false, budget: 16 * 1024 })!.extractor).toBe(id);
    }
  });
});
