import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStateBlock,
  type DecisionRow,
  decideFold,
  decisionsNote,
  errorLines,
  type LogRow,
  openErrors,
  ProjectStore,
  recallSearch,
  recallTerms,
  runReceiptFailed,
  STATE_BLOCK_BYTES,
  topicKey,
} from "../src/index.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "sieve-s4-")));
const store = () => {
  const d = tmp();
  return new ProjectStore({ key: "k", root: d, name: "x", worktree: d }, join(d, "db"));
};

let seq = 0;
const row = (kind: LogRow["kind"], summary: string, extra: Partial<LogRow> = {}): LogRow => ({
  seq: ++seq,
  kind,
  context: "main",
  summary,
  key: null,
  files: [],
  detailId: null,
  createdAt: 1000 + seq,
  ...extra,
});
const bytes = (s: string) => Buffer.byteLength(s);

describe("state block", () => {
  test("goal, last request, open errors, decisions, next steps, files, search terms", () => {
    seq = 0;
    const goal = row("prompt", "add rate limiting to the login route", { key: "request" });
    const rows = [
      goal,
      row("edit", "Edit src/limiter.ts", { files: ["src/limiter.ts"] }),
      row("command", "bun test", { key: "bun test" }),
      row("error", "bun test: FAIL limiter > blocks after 5 tries", { key: "bun test" }),
      row("command", "bun run lint", { key: "bun run lint" }),
      row(
        "todo",
        JSON.stringify([
          { content: "Write limiter", status: "completed" },
          { content: "Fix failing limiter test", status: "in_progress" },
          { content: "Update docs", status: "pending" },
        ]),
      ),
      row("prompt", "continue", { key: null }),
      row("prompt", "also cover the signup route", { key: "request" }),
    ];
    const decisions: DecisionRow[] = [
      { id: 1, topic: "t", label: "Storage", text: "Redis", sessionId: "s", seq: 2, createdAt: 1 },
      {
        id: 2,
        topic: "u",
        label: "Window",
        text: "sliding, 1 minute",
        sessionId: "old",
        seq: 4,
        createdAt: 1,
      },
    ];
    const b = buildStateBlock({ uptoSeq: seq, goal, rows, decisions, sessionId: "s" });
    expect(b).toBe(
      [
        '[sieve state] from the session log, rows up to #8. Any row in full: sieve_resume {"seq":N}',
        "goal (#1): add rate limiting to the login route",
        "last request (#8): also cover the signup route",
        "open errors (latest run of each command failed):",
        "- #4 bun test: FAIL limiter > blocks after 5 tries",
        "decisions in force:",
        "- Storage: Redis (#2)",
        "- Window: sliding, 1 minute (earlier session)",
        "next steps (todo list, #6):",
        "- [in progress] Fix failing limiter test",
        "- [pending] Update docs",
        "files changed: src/limiter.ts",
        "search terms (sieve_search): add, rate, limiting, login, route, cover, signup, limiter",
      ].join("\n"),
    );
    // Pure: same rows, same bytes.
    expect(buildStateBlock({ uptoSeq: seq, goal, rows, decisions, sessionId: "s" })).toBe(b);
  });

  test("a passing rerun closes an open error", () => {
    seq = 0;
    const rows = [
      row("command", "bun test", { key: "bun test" }),
      row("error", "bun test: FAIL x", { key: "bun test" }),
      row("command", "bun test", { key: "bun test" }),
    ];
    expect(openErrors(rows)).toEqual([]);
  });

  test("long rows become sieve_resume pointers; lines are never cut", () => {
    seq = 0;
    const long = `refactor ${"the whole auth module carefully ".repeat(30)}`;
    const goal = row("prompt", long, { key: "request" });
    const b = buildStateBlock({ uptoSeq: 1, goal, rows: [goal], decisions: [], sessionId: "s" });
    expect(b).toContain(
      `goal and last request (#1): a long request (${long.length.toLocaleString("en-US")} chars), sieve_resume {"seq":1}`,
    );
    expect(b).not.toContain("carefully the whole");
  });

  test("never over 2 KB; what does not fit is counted", () => {
    seq = 0;
    const rows = [row("prompt", "make the build green", { key: "request" })];
    for (let i = 0; i < 80; i++) {
      rows.push(row("command", `./check-${i}.sh`, { key: `./check-${i}.sh` }));
      rows.push(
        row("error", `./check-${i}.sh: Error: check ${i} failed with a fairly long message here`, {
          key: `./check-${i}.sh`,
        }),
      );
    }
    const b = buildStateBlock({ uptoSeq: seq, goal: rows[0]!, rows, decisions: [], sessionId: "s" });
    expect(bytes(b)).toBeLessThanOrEqual(STATE_BLOCK_BYTES);
    expect(b).toMatch(/… \d+ more line\(s\) did not fit/);
    expect(b).toContain("goal and last request (#1)");
    // Newest errors first.
    expect(b).toContain("check-79.sh");
    for (const l of b.split("\n")) expect(bytes(l)).toBeLessThanOrEqual(280);
  });

  test("empty log, no decisions → nothing", () => {
    expect(buildStateBlock({ uptoSeq: 0, goal: null, rows: [], decisions: [], sessionId: "s" })).toBe("");
    expect(decisionsNote([])).toBe("");
  });
});

describe("decisions", () => {
  test("the same question asked again replaces the answer; a different one under the same header does not", () => {
    const s = store();
    const w = s.project.worktree;
    const t1 = topicKey("Approach", "Which database should we use for sessions?");
    const t2 = topicKey("Approach", "For sessions, which database should we use?");
    const t3 = topicKey("Approach", "Should the API be REST or GraphQL?");
    expect(t1).toBe(t2);
    expect(t1).not.toBe(t3);
    s.log.decide(w, { topic: t1, label: "Approach", text: "SQLite", sessionId: "a", seq: 1, at: 1 });
    s.log.decide(w, { topic: t3, label: "Approach", text: "REST", sessionId: "a", seq: 2, at: 2 });
    s.log.decide(w, { topic: t2, label: "Approach", text: "Postgres", sessionId: "b", seq: 1, at: 3 });
    expect(s.log.decisions(w).map((d) => d.text)).toEqual(["Postgres", "REST"]);
    expect(s.log.supersededCount(w)).toBe(1);
    expect(decisionsNote(s.log.decisions(w))).toBe(
      [
        "[sieve] Decisions in force for this worktree (from earlier sessions; a newer answer replaces one):",
        "- Approach: Postgres (earlier session)",
        "- Approach: REST (earlier session)",
      ].join("\n"),
    );
    s.close();
  });
});

describe("session log storage", () => {
  test("rows are numbered per session; the stored state block is current until a new row or /clear", () => {
    const s = store();
    const w = s.project.worktree;
    s.touchSession("x", "claude-code", w, 1);
    const base = { context: "main", worktree: w, at: 5 };
    expect(s.log.append("x", { ...base, kind: "prompt", summary: "first goal here", key: "request" })).toBe(
      1,
    );
    expect(s.log.append("x", { ...base, kind: "edit", summary: "Edit a.ts", files: ["a.ts"] })).toBe(2);
    expect(s.log.append("y", { ...base, kind: "prompt", summary: "other session", key: "request" })).toBe(1);
    const built = s.log.buildState("x", w, 10);
    expect(built.uptoSeq).toBe(2);
    expect(s.log.freshState("x")).toBe(built.body);
    s.log.append("x", { ...base, kind: "command", summary: "ls", key: "ls" });
    expect(s.log.freshState("x")).toBeNull();
    s.log.buildState("x", w, 11);
    s.log.markCleared("x");
    expect(s.log.freshState("x")).toBeNull();
    s.log.append("x", { ...base, kind: "prompt", summary: "a fresh start after clear", key: "request" });
    const after = s.log.buildState("x", w, 12).body;
    expect(after).toContain("goal and last request (#4): a fresh start after clear");
    expect(after).not.toContain("first goal here");
    expect(s.log.row("x", 2)?.files).toEqual(["a.ts"]);
    s.close();
  });
});

describe("error detection", () => {
  test("error lines are whole and counted", () => {
    const e = errorLines("ok\nError: boom\nok\nFAIL src/a.test.ts\nError: boom\n");
    expect(e).toEqual({ lines: ["Error: boom", "FAIL src/a.test.ts"], total: 3 });
  });
  test("sieve_run receipts", () => {
    expect(runReceiptFailed("[sieve run] exit 1 · 0.2 s · isolation: none")).toBe(true);
    expect(runReceiptFailed("[sieve run] exit 0 · 0.2 s")).toBe(false);
    expect(runReceiptFailed("[sieve run] timed out after 5 s")).toBe(true);
    expect(runReceiptFailed("hello")).toBe(false);
  });
});

describe("recall terms", () => {
  test("file names, identifiers, quoted and error text; plain words alone give nothing", () => {
    const t = recallTerms(
      'why does src/auth/session.ts throw in refreshToken? I see "token expired before refresh"\nTypeError: cannot read properties of undefined',
    );
    expect(t.files).toEqual(["session.ts"]);
    expect(t.idents).toEqual(["refreshToken", "TypeError"]);
    expect(t.phrases).toEqual([
      ["token", "expired", "refresh"],
      ["typeerror", "cannot", "properties", "undefined"],
    ]);
    const plain = recallTerms("please tidy up the readme and make the tests pass, e.g. the slow ones");
    expect(plain).toEqual({ files: [], idents: [], phrases: [] });
  });
  test("plain words count when the repo defines a symbol of that name", () => {
    const t = recallTerms("what does the limiter do", (w) => w === "limiter");
    expect(t.idents).toEqual(["limiter"]);
  });
});

describe("recall search", () => {
  test("points at earlier sessions' output, never at what the current context already saw", () => {
    const s = store();
    const w = s.project.worktree;
    const put = (text: string, sessionId: string, at: number, source = "Bash: bun test") => {
      const it = s.put(text, { sessionId, worktree: w, sourceKind: "tool", source, at });
      s.index(it.id);
      return it.id;
    };
    const old = put("FAIL refreshToken test\nTypeError: token is undefined in refreshToken", "old", 100);
    const mine = put("refreshToken called twice", "now", 200, "Bash: grep refreshToken");
    const weak = put("unrelated output mentioning session.ts once", "old", 150, "Bash: ls");
    const terms = recallTerms("fix the refreshToken TypeError in session.ts");
    const hits = recallSearch(s.db, terms, { worktree: w, sessionId: "now", epochAt: 0 });
    expect(hits.map((h) => h.archiveId)).toEqual([old, weak]);
    expect(hits[0]!.matched).toBe(2);
    // After compaction (a new epoch), the session's own older output can be pointed at again.
    const later = recallSearch(s.db, terms, { worktree: w, sessionId: "now", epochAt: 300 });
    expect(later.map((h) => h.archiveId)).toContain(mine);
    // Already pointed at → skipped.
    expect(
      recallSearch(s.db, terms, { worktree: w, sessionId: "now", epochAt: 0, skip: new Set([old, weak]) }),
    ).toEqual([]);
    s.close();
  });
});

describe("fold lifts named errors", () => {
  test("a TypeError in the dropped middle of a long output is listed in the receipt", () => {
    const lines = Array.from({ length: 800 }, (_, i) => `step ${i} ok`);
    lines[400] = "TypeError: cannot read properties of undefined (reading 'id')";
    const text = lines.join("\n");
    const item = {
      id: "s_aaaaaaaaaaaa",
      bytes: text.length,
      tokens: 5000,
      tokenizer: "o200k_base",
      lines: 800,
      isNew: true,
    };
    const d = decideFold({ text, isError: false, toolName: "Bash" }, item);
    expect(d.kind).toBe("replace");
    if (d.kind === "replace") expect(d.text).toContain("TypeError: cannot read properties of undefined");
  });
});
