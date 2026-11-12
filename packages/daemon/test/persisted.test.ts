import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { archiveId, paths, resolveProject } from "@sieve/core";
import { PROTOCOL_VERSION, type ToolResult } from "@sieve/protocol";
import { Daemon } from "../src/index.ts";
import { bashPost, freshHome, REPO, runShim } from "./helpers.ts";

/**
 * Claude Code cuts Bash output near 30,000 characters before it reaches a hook. It keeps the
 * whole result in a file and reports it in the tool_response: `stdout` is a prefix of that file,
 * `persistedOutputPath` / `persistedOutputSize` name it. Observed live on 2026-11-11 (Claude Code
 * 2.1.319, 1,500 lines of "PASS case N …", 61,893 bytes, stdout 29,999 bytes); the model then saw
 * only a 2 KB preview in a <persisted-output> wrapper, with or without Sieve. Paths here are
 * rewritten; the field names and sizes are as captured.
 */
const CUT = 29_999;
const SECRET = `AKIA${"IOSFODNN7EXAMPLE"}`; // built from pieces; masked by Sieve's secret masking

function fullOutput(extra: Record<number, string> = {}): string {
  return Array.from(
    { length: 1500 },
    (_, i) => extra[i + 1] ?? `PASS case ${i + 1} lorem ipsum dolor sit amet`,
  ).join("\n");
}
// A failure far past the cut, and a secret in the tail: neither is in what the hook receives.
const FULL = fullOutput({
  1400: "FAIL src/late.test.ts > fails after the cut",
  1401: "Error: expected 1 to be 2",
  1450: `token ${SECRET} leaked`,
});

let env: ReturnType<typeof freshHome>;
let daemon: Daemon;
let project: string;
let n = 0;

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

async function tool(name: string, args: unknown): Promise<ToolResult> {
  const r = await daemon.handleLine(
    JSON.stringify({ v: PROTOCOL_VERSION, id: "t", type: "tool", tool: name, args, cwd: project }),
  );
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.result as ToolResult;
}

/** Claude Code's layout: <config>/projects/<proj>/<session>.jsonl and <session>/tool-results/<name>.txt */
function layout(session: string) {
  const proj = join(env.home, "claude", "projects", "-tmp-proj");
  const dir = join(proj, session, "tool-results");
  mkdirSync(dir, { recursive: true });
  return { proj, dir, transcript: join(proj, `${session}.jsonl`) };
}

function payload(
  session: string,
  full: string,
  file: string,
  transcript: string,
  size = Buffer.byteLength(full),
) {
  return bashPost(full.slice(0, CUT), project, {
    session_id: session,
    transcript_path: transcript,
    tool_response: {
      stdout: full.slice(0, CUT),
      stderr: "",
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
      persistedOutputPath: file,
      persistedOutputSize: size,
    },
  });
}

async function fold(p: unknown) {
  const r = await runShim(p);
  const reply = r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput : null;
  return { reply, text: reply?.stdout as string | undefined };
}

describe("output Claude Code cut before the hook, kept whole in a file", () => {
  test("the archive holds the whole output, so a failure past the cut is found and expands exactly", async () => {
    const s = `s${++n}`;
    const { dir, transcript } = layout(s);
    const file = join(dir, "full.txt");
    writeFileSync(file, FULL);
    const { text } = await fold(payload(s, FULL, file, transcript));
    const id = /\[sieve (s_[a-z2-7]+)\]/.exec(text!)![1]!;
    // the id is the hash of the original bytes: of the whole output, not of the 30 KB prefix
    expect(id).not.toBe(archiveId(FULL.slice(0, CUT)));
    const late = (await tool("sieve_get", { id, lines: "1400-1401" })).content;
    expect(late).toContain("FAIL src/late.test.ts > fails after the cut");
    expect(late).toContain("Error: expected 1 to be 2");
    // the receipt says it is complete, and counts all of it
    expect(text).toContain("1,500 lines");
    expect(text).toContain("Full output archived (60 KB)");
  });

  test("the secret in the tail is masked in the archive: it never reaches the database or the model", async () => {
    const s = `s${++n}`;
    const { dir, transcript } = layout(s);
    const file = join(dir, "full.txt");
    writeFileSync(file, FULL);
    const { text } = await fold(payload(s, FULL, file, transcript));
    const id = /\[sieve (s_[a-z2-7]+)\]/.exec(text!)![1]!;
    const tail = (await tool("sieve_get", { id, lines: "1450-1450" })).content;
    expect(tail).not.toContain(SECRET);
    expect(tail).toContain("<secret:aws_key#");
    expect(text).not.toContain(SECRET);
  });

  test("the first 2 KB, all Claude Code shows, hold the id, how to expand, and that it is only a preview", async () => {
    const s = `s${++n}`;
    const { dir, transcript } = layout(s);
    const file = join(dir, "full.txt");
    writeFileSync(file, FULL);
    const { text } = await fold(payload(s, FULL, file, transcript));
    const id = /\[sieve (s_[a-z2-7]+)\]/.exec(text!)![1]!;
    const shown = Buffer.from(text!).subarray(0, 2000).toString("utf8");
    expect(shown).toContain(`[sieve ${id}]`);
    expect(shown).toContain(`sieve_get {"id":"${id}"`);
    expect(shown).toContain("only the first 2 KB");
    // and the whole receipt fits, so the failure past the cut is inside the window too
    expect(Buffer.byteLength(text!)).toBeLessThanOrEqual(2000);
    expect(shown).toContain("fails after the cut");
  });

  test("a receipt is a pure function of the output: the same content under another path and session is byte-identical", async () => {
    const a = layout("sa");
    const b = layout("sb");
    writeFileSync(join(a.dir, "one.txt"), FULL);
    writeFileSync(join(b.dir, "different-name.txt"), FULL);
    const ra = await fold(payload("sa", FULL, join(a.dir, "one.txt"), a.transcript));
    const rb = await fold(payload("sb", FULL, join(b.dir, "different-name.txt"), b.transcript));
    expect(ra.text).toBe(rb.text);
    expect(ra.text).not.toContain("tool-results");
    expect(ra.text).not.toContain(env.home);
  });

  describe("a path that is not Claude Code's own result file is never read", () => {
    const partial = (text: string | undefined) => {
      expect(text).toContain("[sieve s_");
      expect(text).not.toContain("Full output archived");
      expect(text).toMatch(/first (29|30) KB of 60 KB/);
    };

    test("a file outside this session's tool-results folder", async () => {
      const s = `s${++n}`;
      const { transcript } = layout(s);
      const elsewhere = join(env.home, "elsewhere.txt");
      writeFileSync(elsewhere, FULL);
      const { text } = await fold(payload(s, FULL, elsewhere, transcript));
      partial(text);
    });

    test("another session's folder", async () => {
      const mine = layout(`s${++n}`);
      const other = layout(`s${++n}`);
      writeFileSync(join(other.dir, "x.txt"), FULL);
      const { text } = await fold(payload("mine", FULL, join(other.dir, "x.txt"), mine.transcript));
      partial(text);
    });

    test("a symlink inside the folder that points out of it", async () => {
      const s = `s${++n}`;
      const { dir, transcript } = layout(s);
      const target = join(env.home, "secret-target.txt");
      writeFileSync(target, FULL);
      const link = join(dir, "link.txt");
      symlinkSync(target, link);
      const { text } = await fold(payload(s, FULL, link, transcript));
      partial(text);
    });

    test("a size that does not match what Claude Code reported", async () => {
      const s = `s${++n}`;
      const { dir, transcript } = layout(s);
      const file = join(dir, "full.txt");
      writeFileSync(file, FULL);
      const { text } = await fold(payload(s, FULL, file, transcript, Buffer.byteLength(FULL) + 5));
      expect(text).toContain("[sieve s_");
      expect(text).not.toContain("Full output archived");
    });

    test("content that does not begin with the stdout the hook received", async () => {
      const s = `s${++n}`;
      const { dir, transcript } = layout(s);
      const file = join(dir, "full.txt");
      const other = FULL.replace("PASS case 1 ", "PASS case X ");
      writeFileSync(file, other);
      const { text } = await fold(payload(s, FULL, file, transcript));
      partial(text);
    });

    test("no transcript path to anchor the folder to", async () => {
      const s = `s${++n}`;
      const { dir } = layout(s);
      const file = join(dir, "full.txt");
      writeFileSync(file, FULL);
      const p = payload(s, FULL, file, "");
      const { text } = await fold({ ...p, transcript_path: undefined });
      partial(text);
    });

    test("a file over the read bound is not read (archived as partial)", async () => {
      const s = `s${++n}`;
      const { dir, transcript } = layout(s);
      const file = join(dir, "huge.txt");
      const huge = `${FULL}\n${"x".repeat(5 * 1024 * 1024)}`;
      writeFileSync(file, huge);
      const { text } = await fold(payload(s, huge, file, transcript));
      expect(text).toContain("[sieve s_");
      expect(text).not.toContain("Full output archived");
      expect(text).toContain("only the first 2 KB");
    });
  });

  test("savings are counted against what Claude Code would have shown anyway (about 2 KB), not the 60 KB", async () => {
    const s = `s${++n}`;
    const { dir, transcript } = layout(s);
    const file = join(dir, "full.txt");
    writeFileSync(file, fullOutput({ 7: "unique line for the stats test" }));
    const full = fullOutput({ 7: "unique line for the stats test" });
    await fold(payload(s, full, file, transcript));
    const db = new Database(paths.projectDb(resolveProject(project).key), { readonly: true });
    const row = db
      .query(
        "SELECT tokens_in AS i, tokens_out AS o FROM folds WHERE session_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(s) as { i: number; o: number };
    db.close();
    expect(row.i).toBeLessThan(800); // not ~15,000 tokens
    expect(row.o).toBeLessThanOrEqual(row.i); // the receipt window is no larger than the plain preview
  });

  test("output that was not cut is folded exactly as before", async () => {
    const s = `s${++n}`;
    const out = Array.from({ length: 800 }, (_, i) => `PASS case ${i} lorem ipsum dolor sit amet`).join("\n");
    const { text } = await fold(bashPost(out, project, { session_id: s }));
    expect(text).toContain("Full output archived");
    expect(text).not.toContain("only the first 2 KB");
  });
});

/** Claude Code cuts at 30,000 BYTES (observed live with non-ASCII output: persistedOutputSize is the file's byte length). */
const cutBytes = (full: string, at = 30_000) => Buffer.from(full).subarray(0, at).toString("utf8");
function bytesPayload(session: string, full: string, command = "npx biome check .") {
  const { dir, transcript } = layout(session);
  const file = join(dir, "r.txt");
  writeFileSync(file, full);
  const cut = cutBytes(full);
  return bashPost(cut, project, {
    session_id: session,
    transcript_path: transcript,
    tool_input: { command, description: "check" },
    tool_response: {
      stdout: cut,
      stderr: "",
      interrupted: false,
      persistedOutputPath: file,
      persistedOutputSize: Buffer.byteLength(full),
    },
  });
}

describe("multi-byte output (sizes are in bytes, as observed live)", () => {
  const uni = Array.from({ length: 2500 }, (_, i) => `✓ case ${i + 1} héllo wörld ✗ ok`).join("\n");

  test("a whole result with ✓ and é in it is archived whole, and the receipt says so", async () => {
    const { text } = await fold(bytesPayload(`s${++n}`, uni));
    expect(text).toContain("Full output archived (84 KB)");
    expect(text).not.toContain("the agent passed on no more");
  });

  test("a cut that lands inside a character (it leaves a replacement character) is still the same text", async () => {
    // 3-byte ✓ every 4th byte makes a cut at a non-multiple land inside one
    const full = `${"✓".repeat(12_000)}\nend`;
    const cut = cutBytes(full, 29_999); // 29,999 is not a multiple of 3: mid-character
    expect(cut.endsWith("\uFFFD")).toBe(true);
    const s = `s${++n}`;
    const { dir, transcript } = layout(s);
    const file = join(dir, "m.txt");
    writeFileSync(file, full);
    const p = bashPost(cut, project, {
      session_id: s,
      transcript_path: transcript,
      tool_response: {
        stdout: cut,
        stderr: "",
        interrupted: false,
        persistedOutputPath: file,
        persistedOutputSize: Buffer.byteLength(full),
      },
    });
    const { text } = await fold(p);
    expect(text).toContain("Full output archived");
  });
});

describe("recognised formats, real captured output, through the persisted path", () => {
  test.each([
    ["biome/lint-repeated.txt", "npx biome check ."],
    ["git/diff-range.txt", "git diff main..feature"],
    ["logs/npm-silly.txt", "npm install --loglevel silly"],
    ["search/rg-many.txt", "rg lorem"],
  ])("%s: the receipt, complete, fits the 2 KB window", async (fixture, command) => {
    const full = readFileSync(join(REPO, "packages/core/fixtures", fixture), "utf8");
    expect(Buffer.byteLength(full)).toBeGreaterThan(30_000); // it really is a cut result
    const { text } = await fold(bytesPayload(`s${++n}`, full, command));
    const bytes = Buffer.byteLength(text!);
    expect(bytes).toBeLessThanOrEqual(2000);
    const id = /\[sieve (s_[a-z2-7]+)\]/.exec(text!)![1]!;
    expect(text).toContain(`sieve_get {"id":"${id}"`);
    expect(text).toContain("only the first 2 KB");
    expect(text).toContain("Full output archived");
    expect(text).not.toContain("the agent passed on no more");
  });
});

describe("running the same large command again", () => {
  test("never claims the agent still has it: it only ever saw a 2 KB preview of the first run", async () => {
    const s = `s${++n}`;
    const first = await fold(bytesPayload(s, FULL, "npm test"));
    const second = await fold(bytesPayload(s, FULL, "npm test"));
    expect(second.text).not.toContain("Same output as run");
    expect(second.text).not.toContain("still in your context");
    // and what it gets is the same receipt as the first time: a pure function of the output
    expect(second.text).toBe(first.text);
  });
});
