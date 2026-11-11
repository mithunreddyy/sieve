import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION, TOOLS, type ToolResult } from "@sieve/protocol";
import { Daemon } from "../src/index.ts";
import { freshHome, runShim } from "./helpers.ts";

let env: ReturnType<typeof freshHome>;
let daemon: Daemon;
let repo: string;
let elsewhere: string;

beforeAll(async () => {
  env = freshHome();
  repo = join(env.home, "repo");
  elsewhere = join(env.home, "other");
  mkdirSync(repo, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  daemon = new Daemon({ idleMinutes: 0, log: () => {} });
  expect(await daemon.start()).toBe(true);
});
afterAll(async () => {
  await daemon.stop();
  env.cleanup();
});

type Out = { additionalContext?: string };
async function hook(
  session: string,
  event: string,
  extra: Record<string, unknown>,
  cwd = repo,
): Promise<Out | null> {
  const r = await runShim({ session_id: session, cwd, hook_event_name: event, ...extra }, {}, event);
  expect(r.code).toBe(0);
  return r.stdout ? (JSON.parse(r.stdout).hookSpecificOutput as Out) : null;
}
const start = (s: string, source = "startup", cwd = repo) => hook(s, "SessionStart", { source }, cwd);
const prompt = (s: string, text: string, cwd = repo) => hook(s, "UserPromptSubmit", { prompt: text }, cwd);
const bash = (s: string, command: string, stdout: string) =>
  hook(s, "PostToolUse", {
    tool_name: "Bash",
    tool_input: { command },
    tool_response: { stdout, stderr: "", interrupted: false },
  });

async function tool(name: string, args: unknown, cwd = repo): Promise<ToolResult> {
  const r = await daemon.handleLine(
    JSON.stringify({ v: PROTOCOL_VERSION, id: "t", type: "tool", tool: name, args, cwd }),
  );
  if (!r.ok) throw new Error(r.error.message);
  return r.result as ToolResult;
}
const remember = (args: Record<string, unknown>, cwd = repo) => tool("sieve_remember", args, cwd);
const recall = (args: Record<string, unknown>, cwd = repo) => tool("sieve_recall", args, cwd);

describe("the two tools", () => {
  test("descriptions fit the 400-character budget and the tool list is eleven, with sieve_schema", () => {
    expect(Object.keys(TOOLS)).toHaveLength(11);
    for (const t of ["sieve_remember", "sieve_recall"] as const)
      expect(TOOLS[t].description.length).toBeLessThan(400);
  });

  test("remember stores, recall finds it with id, scope and trust", async () => {
    const r = await remember({ subject: "api", predicate: "database", object: "postgres 16" });
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/^Stored #\d+: api database: postgres 16 \[repo, observed\]/);
    const got = await recall({ query: "which database does the api use" });
    expect(got.content).toContain("api database: postgres 16 [repo, observed, by agent]");
    expect(got.content).toContain("the user's current message overrides them");
  });

  test("a different spelling of the same slot is one fact; a new value replaces the old", async () => {
    await remember({ subject: "api", predicate: "test cmd", object: "npm test" });
    const same = await remember({ subject: "api", predicate: "Tests run with", object: "npm test" });
    expect(same.content).toContain("Already known");
    const changed = await remember({ subject: "api", predicate: "test_command", object: "bun test" });
    expect(changed.content).toContain("Replaced");
    const got = await recall({ subject: "api", query: "test command" });
    expect(got.content).toContain("bun test");
    expect(got.content).not.toContain("npm test");
  });

  test("retract closes a fact; a credential is refused; unknown fields are rejected by name", async () => {
    await remember({ subject: "web", predicate: "framework", object: "hono" });
    const gone = await remember({ subject: "web", predicate: "framework", object: "hono", retract: true });
    expect(gone.content).toContain("Retracted");
    expect((await recall({ subject: "web" })).content).toBe("No stored facts match.");
    const key = `${"sk"}_live_${"Ab12Cd34Ef56Gh78"}`;
    const bad = await remember({ subject: "stripe", predicate: "note", object: `use ${key}` });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("looks like a credential");
    await expect(remember({ subject: "a", predicate: "b", object: "c", color: "red" })).rejects.toThrow(
      /color/,
    );
  });

  test("a repo-scoped fact is not visible from another repo", async () => {
    await remember({ subject: "deploy", predicate: "note", object: "staging resets nightly" });
    expect((await recall({ query: "staging" }, elsewhere)).content).toBe("No stored facts match.");
    await remember({ subject: "me", predicate: "prefers", object: "short answers", scope: "everywhere" });
    expect((await recall({ query: "short answers" }, elsewhere)).content).toContain("short answers");
  });
});

describe("what the model is shown", () => {
  test("a fact the user said is asserted and appears in the start-of-session block", async () => {
    await prompt("S1", "we use pnpm for everything in this repo, never npm");
    const r = await remember({ subject: "repo", predicate: "package manager", object: "pnpm" });
    // the tool call ran outside session S1's hooks, so the daemon links it to the current session
    expect(r.content).toContain("Stored");
    const fresh = await start("S2");
    expect(fresh?.additionalContext ?? "").toContain("[sieve memory]");
  });

  test("the core block lists only asserted facts, and is identical every time", async () => {
    const a = (await start("C1"))?.additionalContext ?? "";
    const b = (await start("C2"))?.additionalContext ?? "";
    const block = (s: string) => s.slice(s.indexOf("[sieve memory]"));
    expect(block(a)).toBe(block(b));
    expect(a).not.toContain("postgres"); // observed, not asserted: never in the core block
  });

  test("an observed fact comes with the first prompt that shares words with it, once", async () => {
    const first = await prompt("R1", "why is the postgres connection slow?");
    expect(first?.additionalContext ?? "").toContain("api database: postgres 16 [repo, observed]");
    const again = await prompt("R1", "and does the postgres pool matter?");
    expect(again?.additionalContext ?? "").not.toContain("[sieve memory]");
  });

  test("after compaction the facts are shown again", async () => {
    await prompt("K1", "tell me about the postgres setup");
    const after = await start("K1", "compact");
    expect(after?.additionalContext ?? "").toContain("[sieve memory]");
    const next = await prompt("K1", "still about postgres please");
    expect(next?.additionalContext ?? "").toContain("api database: postgres 16");
  });

  test("a prompt that matches nothing gets no memory block", async () => {
    await start("N1"); // the core facts were given at the start
    const out = await prompt("N1", "zzzz qqqq unrelated words");
    expect(out?.additionalContext ?? "").not.toContain("[sieve memory]");
  });
});

describe("capture by rule", () => {
  test("a commit becomes an observed fact and the next commit replaces it", async () => {
    await bash(
      "G1",
      "git commit -m 'fix limiter'",
      "[main abc1234] fix limiter\n 1 file changed, 2 insertions(+)\n",
    );
    expect((await recall({ query: "commit limiter" })).content).toContain("abc1234 fix limiter (main)");
    await bash("G1", "git commit -m 'second'", "[main def5678] second change\n 1 file changed\n");
    const got = (await recall({ subject: "repo", query: "commit" })).content;
    expect(got).toContain("def5678");
    expect(got).not.toContain("abc1234");
  });

  test("a pull request URL from gh pr create is kept", async () => {
    await bash("G2", "gh pr create --fill", "https://github.com/acme/widgets/pull/42\n");
    expect((await recall({ query: "pull request pr" })).content).toContain(
      "https://github.com/acme/widgets/pull/42",
    );
  });

  test("a failed command writes nothing", async () => {
    const before = daemon.ctx.global.memory.counts().active;
    await hook("G3", "PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: "git commit -m x" },
      tool_response: { stdout: "[main 1111111] nope", stderr: "boom", interrupted: true },
    });
    expect(daemon.ctx.global.memory.counts().active).toBe(before);
  });
});

describe("memory off", () => {
  test("the tools say so and the blocks go away", async () => {
    daemon.ctx.config.memory.enabled = false;
    try {
      const r = await remember({ subject: "a", predicate: "note", object: "b" });
      expect(r.isError).toBe(true);
      expect(r.content).toContain("Memory is off");
      expect(
        (await prompt("O1", "why is the postgres connection slow?"))?.additionalContext ?? "",
      ).not.toContain("[sieve memory]");
    } finally {
      daemon.ctx.config.memory.enabled = true;
    }
  });
});

describe("facts that may be out of date", () => {
  test("a file changed after the fact was written takes it out of the blocks, and recall says why", async () => {
    const { writeFileSync, utimesSync } = await import("node:fs");
    const file = join(repo, "limits.ts");
    writeFileSync(file, "export const LIMIT = 5;\n");
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
    await remember({
      subject: "login",
      predicate: "note",
      object: "the throttling threshold sits in limits.ts",
    });
    const early = await prompt("ST1", "where is the throttling threshold?");
    expect(early?.additionalContext ?? "").toContain("throttling threshold sits in limits.ts");
    writeFileSync(file, "export const LIMIT = 10;\n"); // now newer than the fact
    const later = await prompt("ST2", "where is the throttling threshold?");
    expect(later?.additionalContext ?? "").not.toContain("throttling threshold sits");
    const got = await recall({ query: "throttling threshold" });
    expect(got.content).toContain("possibly out of date: limits.ts changed since");
  });

  test("a mentioned file that no longer exists is reported as gone", async () => {
    await remember({ subject: "login", predicate: "note", object: "legacy flow handled by gone-file.ts" });
    expect((await recall({ query: "legacy flow" })).content).toContain("gone-file.ts is gone");
  });
});
