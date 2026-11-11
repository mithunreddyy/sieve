import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION, type ToolResult } from "@sieve/protocol";
import { Daemon } from "../src/index.ts";
import { freshHome, runShim } from "./helpers.ts";

// Built from pieces so this file holds no contiguous secret-shaped string.
const GH = `ghp_${"q1W2e3R4t5".repeat(4)}`;
const AWS = `AKIA${"IOSFODNN7EXAMPLE"}`;
const ENVVAL = "whsec_Zx9Qw8Er7Ty6Ui5Op4";
const BEARER = "Zk3Lm9Qw7Er5Ty1Ui8Op2As4";
const PW = "s3cr3tPass99Xyz";
const ALL = [GH, AWS, ENVVAL, BEARER, PW];

let env: ReturnType<typeof freshHome>;
let daemon: Daemon;
let repo: string;

beforeAll(async () => {
  env = freshHome();
  repo = join(env.home, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, ".env"), `STRIPE_WEBHOOK=${ENVVAL}\nPORT=3000\n`);
  writeFileSync(join(repo, "config.ts"), `export const db = "postgres://app:${PW}@db.internal:5432/app";\n`);
  daemon = new Daemon({ idleMinutes: 0, log: () => {} });
  expect(await daemon.start()).toBe(true);
});
afterAll(async () => {
  await daemon.stop();
  env.cleanup();
});

const hook = async (event: string, extra: Record<string, unknown>) => {
  const r = await runShim({ session_id: "S", cwd: repo, hook_event_name: event, ...extra }, {}, event);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
};
async function tool(name: string, args: unknown): Promise<ToolResult> {
  const r = await daemon.handleLine(
    JSON.stringify({ v: PROTOCOL_VERSION, id: "t", type: "tool", tool: name, args, cwd: repo }),
  );
  if (!r.ok) throw new Error(r.error.message);
  return r.result as ToolResult;
}

/** Which of the secrets appear in a text (so a failure names them without printing the text). */
const leaks = (text: string) => ALL.concat([`${PW}abc`]).filter((s) => text.includes(s));

/** Every text column of every table in the project database. */
function dump(): string {
  const { store } = daemon.ctx.project(repo);
  const out: string[] = [];
  const tables = store.db
    .query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%\\_%' ESCAPE '\\' OR name IN ('chunks','sightings','session_log','state_blocks','decisions','symbols','runs','reads','files','archive')",
    )
    .all() as { name: string }[];
  for (const { name } of tables) {
    for (const row of store.db.query(`SELECT * FROM ${name}`).all() as Record<string, unknown>[]) {
      for (const v of Object.values(row)) {
        if (typeof v === "string") out.push(v);
        else if (v instanceof Uint8Array)
          out.push(Buffer.from(Bun.gunzipSync(v as Uint8Array<ArrayBuffer>)).toString("utf8"));
      }
    }
  }
  return out.join("\n");
}

describe("raw secrets never reach the database or the model through Sieve", () => {
  const big = [
    ...Array.from({ length: 1500 }, (_, i) => `PASS case ${i}`),
    `export GITHUB_TOKEN=${GH}`,
    `aws_access_key_id = ${AWS}`,
    `webhook secret is ${ENVVAL}`,
    ...Array.from({ length: 200 }, (_, i) => `more ${i}`),
  ].join("\n");

  test("a large tool result: the receipt, the archive, search and the session log are all clean", async () => {
    await hook("UserPromptSubmit", { prompt: `use the token ${GH} to run the deploy` });
    const out = await hook("PostToolUse", {
      tool_name: "Bash",
      tool_input: {
        command: `curl -H "Authorization: Bearer ${BEARER}" https://api.example.com/deploy`,
        description: "deploy",
      },
      tool_response: { stdout: big, stderr: "", interrupted: false },
    });
    const receipt = out.updatedToolOutput.stdout as string;
    expect(leaks(receipt)).toEqual([]);
    const id = /\[sieve (s_[a-z2-7]+)\]/.exec(receipt)![1]!;
    const got = await tool("sieve_get", { id });
    expect(got.content).toContain("export GITHUB_TOKEN=<secret:github_token#1>");
    expect(got.content).toContain("webhook secret is <secret:env_value#1>");
    expect(leaks(got.content)).toEqual([]);
    await daemon.ctx.queue.drain();
    for (const q of ["GITHUB_TOKEN", "whsec", "AKIA", "deploy"])
      expect(leaks((await tool("sieve_search", { query: q })).content)).toEqual([]);
    expect(leaks(dump())).toEqual([]);
  });

  test("a failing command with a secret in it and in its error: log rows and the state block are clean", async () => {
    await hook("PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: `psql postgres://app:${PW}@db.internal/app -c select` },
      tool_response: {
        stdout: "",
        stderr: `Error: password authentication failed for postgres://app:${PW}@db.internal`,
        interrupted: false,
      },
    });
    const state = (await tool("sieve_resume", {})).content;
    expect(state).toContain("open errors");
    expect(leaks(state)).toEqual([]);
    expect(leaks(dump())).toEqual([]);
    expect(dump()).toContain("<secret:");
  });

  test("a file the agent reads: its archived copy is masked, while the read itself is untouched", async () => {
    const text = `export const db = "postgres://app:${PW}@db.internal:5432/app";\n`;
    await hook("PostToolUse", {
      tool_name: "Read",
      tool_input: { file_path: join(repo, "config.ts") },
      tool_response: {
        type: "text",
        file: { filePath: join(repo, "config.ts"), content: text, numLines: 1, startLine: 1, totalLines: 1 },
      },
    });
    await daemon.ctx.queue.drain();
    expect(leaks(dump())).toEqual([]);
    // The agent's own read passes through: the hook does not rewrite a Read result.
    const { store } = daemon.ctx.project(repo);
    const id = (
      store.db.query("SELECT archive_id AS id FROM sightings WHERE source = 'config.ts'").get() as {
        id: string;
      }
    ).id;
    expect(store.get(id)?.text).toContain("postgres://app:<secret:url_password#1>@db.internal");
  });

  test("an unchanged re-read is still recognised (the file's id is its real content hash)", async () => {
    const d = await hook("PreToolUse", {
      tool_name: "Read",
      tool_input: { file_path: join(repo, "config.ts") },
    });
    expect(d?.permissionDecisionReason).toContain("unchanged since your read");
  });

  test("a rerun of a command containing a secret is still diffed against the earlier run", async () => {
    const cmd = `curl -u admin:${PW}abc https://x.example.com/status`;
    const outA = Array.from({ length: 300 }, (_, i) => `row ${i} ok`).join("\n");
    const run = (stdout: string) =>
      hook("PostToolUse", {
        tool_name: "Bash",
        tool_input: { command: cmd },
        tool_response: { stdout, stderr: "", interrupted: false },
      });
    await run(outA);
    const again = await run(outA);
    expect(again.updatedToolOutput.stdout).toContain("Same output as run #1 of this command");
    expect(leaks(dump())).toEqual([]);
  });
});
