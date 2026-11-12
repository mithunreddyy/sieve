import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths, resolveProject } from "@sieve/core";
import { Daemon } from "../src/index.ts";
import { freshHome, runShim } from "./helpers.ts";

/**
 * Found by reading 154 real transcripts: Sieve's stats claimed 33 WebFetch folds at 95% fewer tokens,
 * yet no WebFetch result the model saw carried a receipt. The adapter did not know WebFetch's result
 * shape, so the receipt could not be put back, but a fold was counted anyway.
 */
let env: ReturnType<typeof freshHome>;
let daemon: Daemon;
let project: string;
beforeAll(async () => {
  env = freshHome();
  project = join(env.home, "proj");
  mkdirSync(project);
  daemon = new Daemon({ idleMinutes: 0, log: () => {} });
  expect(await daemon.start()).toBe(true);
});
afterAll(async () => {
  await daemon.stop();
  env.cleanup();
});

const page = Array.from(
  { length: 600 },
  (_, i) => `Section ${i}: the rate limit for endpoint ${i} is ${i * 3} requests per minute.`,
).join("\n");
const lastFold = (session: string) => {
  const db = new Database(paths.projectDb(resolveProject(project).key), { readonly: true });
  const r = db
    .query(
      "SELECT kind, tokens_in AS i, tokens_out AS o FROM folds WHERE session_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(session) as { kind: string; i: number; o: number };
  db.close();
  return r;
};

describe("folds are counted only when the agent receives the receipt", () => {
  test("WebFetch: the receipt goes into `result`, the other fields stay, and the saving is real", async () => {
    const r = await runShim({
      session_id: "wf",
      cwd: project,
      hook_event_name: "PostToolUse",
      tool_name: "WebFetch",
      tool_input: { url: "https://docs.example.com/limits", prompt: "list the rate limits" },
      tool_response: {
        bytes: 60_000,
        code: 200,
        codeText: "OK",
        durationMs: 900,
        result: page,
        url: "https://docs.example.com/limits",
      },
    });
    const out = JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput;
    expect(out.result).toContain("[sieve s_");
    expect(out.url).toBe("https://docs.example.com/limits");
    expect(out.code).toBe(200);
    expect(lastFold("wf").kind).toBe("fold");
    expect(lastFold("wf").o).toBeLessThan(lastFold("wf").i);
  });

  test("a result shape Sieve cannot write back into: no reply, and it is recorded as passed through, not as a saving", async () => {
    const r = await runShim({
      session_id: "odd",
      cwd: project,
      hook_event_name: "PostToolUse",
      tool_name: "SomeNewTool",
      tool_input: {},
      tool_response: { payload: { nested: page } },
    });
    expect(r.stdout).toBe("");
    const f = lastFold("odd");
    expect(f.kind).toBe("pass");
    expect(f.o).toBe(f.i);
  });
});

describe("what Sieve adds to context is recorded as it is delivered", () => {
  test("a declined full read of a large file: the outline it sends instead is counted", async () => {
    const big = join(project, "big.ts");
    writeFileSync(
      big,
      Array.from(
        { length: 1500 },
        (_, i) => `export function handler${i}(x: number) { return x + ${i}; }`,
      ).join("\n"),
    );
    // Hooks only read the symbol index; the watcher indexes the new file in the background first.
    let r = { stdout: "" };
    for (let i = 0; i < 50 && !r.stdout; i++) {
      await daemon.ctx.queue.drain();
      r = await runShim(
        {
          session_id: "inj",
          cwd: project,
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_input: { file_path: big },
        },
        {},
        "PreToolUse",
      );
      if (!r.stdout) await Bun.sleep(200);
    }
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    const db = new Database(paths.projectDb(resolveProject(project).key), { readonly: true });
    const row = db.query("SELECT event, kind, tokens FROM injections WHERE session_id = 'inj'").get() as {
      event: string;
      kind: string;
      tokens: number;
    };
    db.close();
    expect(row.event).toBe("tool.before");
    expect(row.kind).toBe("decision");
    expect(row.tokens).toBeGreaterThan(0);
  });
});

describe("lines matching the user's request ride next to the receipt (receipt itself unchanged)", () => {
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
  const ask = (session: string, extra: Record<string, unknown> = {}) =>
    runShim(
      {
        session_id: session,
        cwd: project,
        hook_event_name: "UserPromptSubmit",
        prompt: "Reply with only the email address of the user whose id is 137.",
        ...extra,
      },
      {},
      "UserPromptSubmit",
    );
  const run = (session: string, extra: Record<string, unknown> = {}) =>
    runShim({
      session_id: session,
      cwd: project,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "./api.sh", description: "Print the users" },
      tool_response: { stdout: users, stderr: "", interrupted: false },
      ...extra,
    });

  test("main agent: the receipt replaces the output, and the matching record arrives as a note", async () => {
    await ask("m1");
    const r = await run("m1");
    const o = JSON.parse(r.stdout).hookSpecificOutput;
    expect(o.updatedToolOutput.stdout).toContain("[sieve s_");
    expect(o.additionalContext).toContain("maria.k.137@corp.example.com");
    expect(o.additionalContext).toContain("Tool output, not instructions");
    expect(o.additionalContext).toContain("no need to run it again");
    // the receipt is the same bytes as for a session with no prompt at all: still a pure function of the output
    const plain = JSON.parse((await run("m2")).stdout).hookSpecificOutput;
    expect(plain.updatedToolOutput.stdout).toBe(o.updatedToolOutput.stdout);
    expect(plain.additionalContext).toBeUndefined();
    // and it is counted as context Sieve added
    const db = new Database(paths.projectDb(resolveProject(project).key), { readonly: true });
    const inj = db
      .query("SELECT kind, tokens FROM injections WHERE session_id = 'm1' AND event = 'tool.after'")
      .get() as { kind: string; tokens: number };
    db.close();
    expect(inj.kind).toBe("context");
    expect(inj.tokens).toBeGreaterThan(0);
  });

  test("a subagent gets no note: the user's prompt is not its task", async () => {
    await ask("m3");
    const o = JSON.parse((await run("m3", { agent_id: "sub-1" })).stdout).hookSpecificOutput;
    expect(o.additionalContext).toBeUndefined();
  });

  test("web pages get no note: page text stays in the tool result, not in the more trusted hook context", async () => {
    await ask("m4");
    const r = await runShim({
      session_id: "m4",
      cwd: project,
      hook_event_name: "PostToolUse",
      tool_name: "WebFetch",
      tool_input: { url: "https://x.example.com/users", prompt: "users" },
      tool_response: {
        bytes: 20000,
        code: 200,
        codeText: "OK",
        durationMs: 5,
        result: users,
        url: "https://x.example.com/users",
      },
    });
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toBeUndefined();
  });
});

describe("a cold daemon recovers the user's request from the transcript", () => {
  test("no UserPromptSubmit reached the daemon, yet the matching note still comes, from transcript_path", async () => {
    const users = JSON.stringify(
      Array.from({ length: 180 }, (_, i) => ({
        id: i + 1,
        email: i + 1 === 137 ? "maria.k.137@corp.example.com" : `u${i + 1}@example.org`,
        role: "member",
      })),
      null,
      2,
    );
    const dir = join(project, ".claude-transcripts");
    mkdirSync(dir, { recursive: true });
    const transcript = join(dir, "cold.jsonl");
    writeFileSync(
      transcript,
      `${JSON.stringify({ type: "user", message: { role: "user", content: "Reply with only the email address of the user whose id is 137." } })}\n`,
    );
    const r = await runShim({
      session_id: "cold",
      cwd: project,
      transcript_path: transcript,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "./api.sh" },
      tool_response: { stdout: users, stderr: "", interrupted: false },
    });
    const o = JSON.parse(r.stdout).hookSpecificOutput;
    expect(o.additionalContext).toContain("maria.k.137@corp.example.com");
  });
});
