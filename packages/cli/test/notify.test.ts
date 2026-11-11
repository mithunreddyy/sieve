import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { notifyProblems } from "../src/notify.ts";

const dir = mkdtempSync("/tmp/sv-notify-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("notify on silent bypass", () => {
  test("one notification per new problem, none for repeats, again when it comes back", () => {
    const file = join(dir, "n.json");
    const got: string[] = [];
    const n = (t: string, b: string) => {
      got.push(`${t} | ${b}`);
    };
    const bad = [
      { agent: "claude-code", problems: ["hooks no longer point at Sieve"] },
      { agent: "codex", problems: [] },
    ];
    expect(notifyProblems(bad, n, file)).toEqual(["claude-code: hooks no longer point at Sieve"]);
    expect(got[0]).toContain("Run: sieve setup --agents claude-code");
    expect(notifyProblems(bad, n, file)).toEqual([]); // already told
    expect(notifyProblems([{ agent: "claude-code", problems: [] }], n, file)).toEqual([]); // fixed: forgotten
    expect(notifyProblems(bad, n, file)).toHaveLength(1); // and reported again when it returns
    expect(got).toHaveLength(2);
  });

  test("a notification that could not be shown is tried again next time", () => {
    const file = join(dir, "m.json");
    const fail = () => {
      throw new Error("no notifier");
    };
    const bad = [{ agent: "cursor", problems: ["mcp entry missing"] }];
    expect(notifyProblems(bad, fail, file)).toEqual([]);
    const ok: string[] = [];
    expect(notifyProblems(bad, (_t, b) => void ok.push(b), file)).toHaveLength(1);
    expect(existsSync(file)).toBe(true);
  });
});
