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
