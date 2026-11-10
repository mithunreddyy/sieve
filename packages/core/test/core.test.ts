import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveId,
  base32,
  chunkText,
  cleanTerminal,
  countTokens,
  decideFold,
  fallbackPlan,
  HOOK_BUDGET,
  MAX_CHUNK_BYTES,
  openDatabase,
  PROJECT_MIGRATIONS,
  ProjectStore,
  resolveProject,
  search,
  snippet,
  suggest,
} from "../src/index.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "sieve-core-")));

function store(): ProjectStore {
  const dir = tmp();
  return new ProjectStore({ key: "k", root: dir, name: "x", worktree: dir }, join(dir, "sieve.db"));
}

describe("ids", () => {
  test("base32 matches RFC 4648", () => {
    expect(base32(new TextEncoder().encode("foobar"))).toBe("mzxw6ytboi");
  });
  test("archive ids are content-addressed", () => {
    expect(archiveId("hello")).toBe(archiveId("hello"));
    expect(archiveId("hello")).not.toBe(archiveId("hello!"));
    expect(archiveId("x")).toMatch(/^s_[a-z2-7]{12}$/);
  });
});

describe("project resolution", () => {
  test("worktrees of one repo share a key but keep their own worktree root", () => {
    const dir = tmp();
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    git("worktree", "add", "-q", join(dir, "wt"), "-b", "feature");
    mkdirSync(join(repo, "src"));
    const a = resolveProject(join(repo, "src"));
    const b = resolveProject(join(dir, "wt"));
    expect(a.key).toBe(b.key);
    expect(a.root).toBe(repo);
    expect(a.worktree).toBe(repo);
    expect(b.worktree).toBe(join(dir, "wt"));
  });
  test("a directory outside git keys on its own path", () => {
    const dir = tmp();
    const p = resolveProject(dir);
    expect(p.root).toBe(dir);
    expect(p.key).toHaveLength(16);
  });
});

describe("text", () => {
  test("strips ANSI and collapses progress redraws", () => {
    expect(cleanTerminal("\x1b[32mok\x1b[0m\n10%\r50%\r100%\ndone")).toBe("ok\n100%\ndone");
  });
  test("token counts come from a real tokenizer and are stable on long input", () => {
    const s = "const value = computeSomething(alpha, beta);\n".repeat(5000);
    const n = countTokens(s);
    expect(n).toBe(countTokens(s));
    expect(n).toBeGreaterThan(0);
    expect(n).not.toBe(Math.round(s.length / 3));
  });
});

describe("chunker", () => {
  test("splits by heading and titles chunks with the heading path", () => {
    const md = "# Guide\nintro\n## Install\nrun it\n## Usage\nuse it\n";
    const c = chunkText(md);
    expect(c.map((x) => x.title)).toEqual([
      "Guide (lines 1-2)",
      "Guide > Install (lines 3-4)",
      "Guide > Usage (lines 5-6)",
    ]);
  });
  test("keeps a code block that fits whole, and no chunk exceeds 4 KB", () => {
    const filler = "word ".repeat(150);
    const code = `\`\`\`ts\n${"let x = 1;\n".repeat(200)}\`\`\``;
    const text = `${filler}\n${filler}\n${filler}\n${filler}\n${code}\nafter\n`;
    const c = chunkText(text);
    for (const ch of c) expect(Buffer.byteLength(ch.body)).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    const codeChunk = c.find((ch) => ch.body.includes("```ts"))!;
    expect(codeChunk.body.split("```").length).toBe(3);
    expect(codeChunk.isCode).toBe(true);
  });
  test("cuts a giant single line without breaking surrogate pairs", () => {
    const c = chunkText("😀".repeat(5000));
    for (const ch of c) {
      expect(Buffer.byteLength(ch.body)).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
      expect(ch.body).not.toContain("�");
    }
    expect(c.map((x) => x.body).join("")).toBe("😀".repeat(5000));
  });
});

describe("archive", () => {
  test("stores originals exactly and dedupes by content", () => {
    const s = store();
    const text = "line 1\nline 2\nline 3\n";
    const a = s.put(text, { worktree: "/w", sourceKind: "tool", source: "Bash" });
    const b = s.put(text, { worktree: "/w", sourceKind: "tool", source: "Bash" });
    expect(a.isNew).toBe(true);
    expect(b.isNew).toBe(false);
    expect(b.id).toBe(a.id);
    expect(s.get(a.id)!.text).toBe(text);
    expect(s.get(a.id, { from: 2, to: 3 })!.text).toBe("line 2\nline 3");
    expect(s.totals().sightings).toBe(2);
  });
  test("every archived byte comes back, including binary-ish text", () => {
    const s = store();
    const text = `${"\x00\x1b[31mred\x1b[0m é 漢字 😀\r\n".repeat(1000)}`;
    const a = s.put(text, { worktree: "/w", sourceKind: "tool", source: "x" });
    expect(s.get(a.id)!.text).toBe(text);
  });
});

describe("search", () => {
  function seeded() {
    const s = store();
    const now = Date.now();
    const put = (text: string, source: string, session: string, worktree = "/w", at = now) => {
      const it = s.put(text, { worktree, sessionId: session, sourceKind: "tool", source, at });
      s.index(it.id);
      return it.id;
    };
    const auth = put(
      "export function authMiddleware(req) {\n  return verifyToken(req.headers.authorization);\n}",
      "src/authMiddleware.ts",
      "s1",
    );
    const db = put(
      "Connection refused while connecting to postgres on port 5432",
      "npm test",
      "s2",
      "/other",
    );
    const old = put("postgres migration finished", "migrate", "s1", "/w", now - 60 * 86_400_000);
    return { s, auth, db, old, now };
  }
  test("trigram finds partial names", () => {
    const { s, auth } = seeded();
    const r = search(s.db, { query: "authMid" });
    expect(r.hits[0]?.archiveId).toBe(auth);
  });
  test("porter stemming matches word forms", () => {
    const { s, db } = seeded();
    expect(search(s.db, { query: "connect refusing" }).hits.map((h) => h.archiveId)).toContain(db);
  });
  test("recency boosts newer items", () => {
    const { s, db, old } = seeded();
    const ids = search(s.db, { query: "postgres" }).hits.map((h) => h.archiveId);
    expect(ids.indexOf(db)).toBeLessThan(ids.indexOf(old));
  });
  test("scopes filter by session and worktree", () => {
    const { s, db } = seeded();
    expect(
      search(s.db, { query: "postgres", scope: "session", sessionId: "s1" }).hits.map((h) => h.archiveId),
    ).not.toContain(db);
    expect(
      search(s.db, { query: "postgres", scope: "worktree", worktree: "/other" }).hits.map((h) => h.archiveId),
    ).toEqual([db]);
  });
  test("pages of 5 with a cursor; timeline sorts oldest first", () => {
    const s = store();
    for (let i = 0; i < 12; i++) {
      const it = s.put(`kiwi item ${i}`, {
        worktree: "/w",
        sourceKind: "index",
        source: `f${i}`,
        at: 1000 + i,
      });
      s.index(it.id);
    }
    const p1 = search(s.db, { query: "kiwi", sort: "timeline" });
    expect(p1.hits).toHaveLength(5);
    expect(p1.total).toBe(12);
    expect(p1.hits[0]!.snippet).toBe("kiwi item 0");
    const p3 = search(s.db, { query: "kiwi", sort: "timeline", cursor: "10" });
    expect(p3.hits).toHaveLength(2);
    expect(p3.nextCursor).toBeNull();
  });
  test("snippets are at most 800 bytes and centred on a match", () => {
    const body = Array.from({ length: 200 }, (_, i) =>
      i === 150 ? "the needle is here" : `filler line ${i}`,
    ).join("\n");
    const sn = snippet(body, ["needle"], false);
    expect(Buffer.byteLength(sn)).toBeLessThanOrEqual(800);
    expect(sn).toContain("needle");
  });
});

describe("fold", () => {
  const big = Array.from({ length: 2000 }, (_, i) => `PASS src/module${i}.test.ts (${i} ms)`).join("\n");
  const item = (text: string) => ({
    id: archiveId(text),
    bytes: text.length,
    tokens: 1,
    tokenizer: "o200k_base",
    lines: 2000,
    isNew: true,
  });

  test("output under 1 KB passes through", () => {
    expect(decideFold({ text: "small", isError: false }, item("small")).kind).toBe("pass");
  });
  test("large output becomes a receipt with id, sizes, and expand instructions", () => {
    const d = decideFold({ text: big, isError: false }, item(big));
    expect(d.kind).toBe("replace");
    if (d.kind !== "replace") return;
    expect(d.text).toContain(`[sieve ${archiveId(big)}]`);
    expect(d.text).toContain("sieve_get");
    expect(d.text).toContain("Do not re-run");
    expect(d.text.length).toBeLessThan(big.length / 2);
  });
  test("receipts are byte-identical for identical input (cache-safe)", () => {
    const a = decideFold({ text: big, isError: false, intent: "module1999" }, item(big));
    const b = decideFold({ text: big, isError: false, intent: "module1999" }, item(big));
    expect(a).toEqual(b);
  });
  test("intent pulls matching lines out of the dropped middle", () => {
    const p = fallbackPlan(big, HOOK_BUDGET, "module1000")!;
    expect(p.intentLines.some((l) => l.includes("module1000.test.ts"))).toBe(true);
  });
  test("failure lines in the dropped middle are lifted into the receipt", () => {
    const text = [
      ...Array.from({ length: 1000 }, (_, i) => `ok line ${i}`),
      " FAIL  src/a.test.ts > adds",
      "AssertionError: expected 3 to be 4",
      " ❯ src/a.test.ts:9:5",
      ...Array.from({ length: 1000 }, (_, i) => `ok tail ${i}`),
    ].join("\n");
    const p = fallbackPlan(text, HOOK_BUDGET)!;
    expect(p.errorLines.join("\n")).toContain("AssertionError: expected 3 to be 4");
    expect(p.errorLines.join("\n")).toContain("src/a.test.ts:9:5");
  });
  test("errors are never cut, only cleaned", () => {
    const err = `\x1b[31m${"Error: boom at line\n".repeat(400)}\x1b[0m`;
    const d = decideFold({ text: err, isError: true }, item(err));
    if (d.kind === "replace") expect(d.text).toContain("Error: boom at line\n".repeat(400).trimEnd());
  });
  test("a fold that saves too little is not applied", () => {
    const mid = `${"x".repeat(4000)}\n${"y".repeat(500)}`;
    expect(decideFold({ text: mid, isError: false }, item(mid)).kind).toBe("pass");
  });
});

describe("spelling and filters", () => {
  test("a word with no matches is replaced by the closest indexed word", () => {
    const s = store();
    const it = s.put("ECONNREFUSED: connection refused by the database listener", {
      worktree: "/w",
      sourceKind: "tool",
      source: "x",
    });
    s.index(it.id);
    const r = search(s.db, { query: "conection listner" });
    expect(r.corrections).toEqual([
      { from: "conection", to: "connection" },
      { from: "listner", to: "listener" },
    ]);
    expect(r.hits[0]?.archiveId).toBe(it.id);
    expect(search(s.db, { query: "conection", spellfix: false }).total).toBe(0);
  });
  test("short words and numbers are never 'corrected'", () => {
    const s = store();
    s.index(s.put("port 5432 open", { worktree: "/w", sourceKind: "tool", source: "x" }).id);
    expect(search(s.db, { query: "5433" }).corrections).toEqual([]);
    expect(search(s.db, { query: "pork" }).corrections).toEqual([{ from: "pork", to: "port" }]);
  });
  test("archiveIds restricts results", () => {
    const s = store();
    const a = s.put("alpha marker one", { worktree: "/w", sourceKind: "tool", source: "a" });
    const b = s.put("alpha marker two", { worktree: "/w", sourceKind: "tool", source: "b" });
    s.index(a.id);
    s.index(b.id);
    expect(search(s.db, { query: "marker", archiveIds: [b.id] }).hits.map((h) => h.archiveId)).toEqual([
      b.id,
    ]);
    expect(search(s.db, { query: "marker", archiveIds: [] }).total).toBe(0);
  });
  test("a version-1 database upgrades and backfills the vocabulary", () => {
    const dir = tmp();
    const file = join(dir, "old.db");
    const v1 = openDatabase(file, PROJECT_MIGRATIONS.slice(0, 1));
    v1.run(
      "INSERT INTO archive (id, bytes, tokens, tokenizer, lines, content, created_at, last_read_at) VALUES ('s_a', 1, 1, 't', 1, x'00', 0, 0)",
    );
    v1.run(
      "INSERT INTO chunks (archive_id, seq, title, body, start_line, end_line) VALUES ('s_a', 0, 't', 'kubernetes deployment', 1, 1)",
    );
    v1.close();
    const v2 = openDatabase(file, PROJECT_MIGRATIONS);
    expect((v2.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      PROJECT_MIGRATIONS.length,
    );
    expect(suggest(v2, "kubernets")).toBe("kubernetes");
  });
});

describe("stepwise indexing", () => {
  const big = Array.from({ length: 4000 }, (_, i) => `line ${i} with zebra${i % 50} data`).join("\n");
  test("indexes in bounded steps and ends searchable", () => {
    const s = store();
    const it = s.put(big, { worktree: "/w", sourceKind: "tool", source: "x" });
    let steps = 0;
    for (let r = s.indexStep(it.id, 4); ; r = s.indexStep(it.id, 4)) {
      steps++;
      expect(r.inserted).toBeLessThanOrEqual(4);
      if (r.done) break;
    }
    expect(steps).toBeGreaterThan(5);
    expect(s.unindexed()).toEqual([]);
    expect(search(s.db, { query: "zebra17" }).total).toBeGreaterThan(0);
  });
  test("a crash between steps is recovered without duplicate chunks", () => {
    const dir = tmp();
    const ref = { key: "k", root: dir, name: "x", worktree: dir };
    const a = new ProjectStore(ref, join(dir, "db"));
    const it = a.put(big, { worktree: "/w", sourceKind: "tool", source: "x" });
    a.indexStep(it.id, 3);
    a.close(); // the daemon dies mid-index
    const b = new ProjectStore(ref, join(dir, "db"));
    expect(b.unindexed()).toEqual([it.id]);
    const n = (b.db.query("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
    b.index(it.id);
    const total = (b.db.query("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
    expect(n).toBe(3);
    expect(total).toBe(
      new Set((b.db.query("SELECT seq FROM chunks").all() as { seq: number }[]).map((r) => r.seq)).size,
    );
    expect(b.unindexed()).toEqual([]);
  });
});
