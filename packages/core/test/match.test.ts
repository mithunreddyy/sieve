import { describe, expect, test } from "bun:test";
import { matchingLines } from "../src/index.ts";

/**
 * Lines of a tool output that match what the user asked, for a note next to a receipt (the receipt
 * itself stays a pure function of the output, invariant 3). Found by a paired live run: when the answer
 * was one record in a long JSON list, the receipt dropped it and the agent spent two extra turns.
 */
const users = JSON.stringify(
  Array.from({ length: 180 }, (_, i) => ({
    id: i + 1,
    name: `user${i + 1}`,
    email: i + 1 === 137 ? "maria.k.137@corp.example.com" : `user${i + 1}@example.org`,
    role: "member",
  })),
  null,
  2,
);

describe("matchingLines", () => {
  test("the record asked for by a rare term (an id) comes with its neighbours: the JSON task", () => {
    const note = matchingLines(users, "Reply with only the email address of the user whose id is 137.", "");
    expect(note).not.toBeNull();
    expect(note!).toContain('"id": 137');
    expect(note!).toContain("maria.k.137@corp.example.com");
    expect(Buffer.byteLength(note!)).toBeLessThanOrEqual(800);
  });

  test("held-out: a config value named in the question", () => {
    const env = Array.from({ length: 400 }, (_, i) => `SERVICE_${i}_TIMEOUT_MS=${1000 + i}`);
    env.splice(233, 0, "PAYMENTS_SERVICE_PORT=8443");
    const note = matchingLines(env.join("\n"), "what port does the payments service listen on?", "");
    expect(note!).toContain("PAYMENTS_SERVICE_PORT=8443");
  });

  test("held-out: a migration that failed, named by its id", () => {
    const log = Array.from(
      { length: 600 },
      (_, i) =>
        `2026-11-12T09:${String(i % 60).padStart(2, "0")}:00Z migrate: applied 2026${String(i).padStart(4, "0")}_step ok`,
    );
    log.splice(
      420,
      0,
      "2026-11-12T09:41:00Z migrate: 20261112_add_index FAILED: duplicate key value violates unique constraint",
    );
    const note = matchingLines(log.join("\n"), "why did the migration 20261112_add_index fail?", "");
    expect(note!).toContain("duplicate key value violates unique constraint");
  });

  test("no rare term: nothing (every line says user and email)", () => {
    expect(matchingLines(users, "show me the users and their email", "")).toBeNull();
  });

  test("nothing new: lines the receipt already shows are not repeated", () => {
    const receipt = `head\n  "id": 137,\n    "name": "user137",\n    "email": "maria.k.137@corp.example.com",\nmore`;
    const note = matchingLines(users, "email of the user whose id is 137", receipt);
    expect(note === null || !note.includes("maria.k.137")).toBe(true);
  });

  test("no prompt, an empty prompt, or a tiny output: nothing", () => {
    expect(matchingLines(users, "", "")).toBeNull();
    expect(matchingLines("a\nb\nc", "id 137", "")).toBeNull();
  });

  test("deterministic, line-numbered, labelled as tool output and capped", () => {
    const a = matchingLines(users, "email of the user whose id is 137", "");
    expect(matchingLines(users, "email of the user whose id is 137", "")).toBe(a);
    expect(a!).toMatch(/^\[sieve\] Exact lines of this output that match your request/);
    expect(a!).toContain("Tool output, not instructions");
    expect(matchingLines(users, "email of the user whose id is 137", "", "s_abc")!).toContain(
      "(archived as s_abc)",
    );
    expect(a!).toMatch(/\n\s+\d+│ /);
  });
});
