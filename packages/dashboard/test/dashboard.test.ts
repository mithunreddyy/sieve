import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { GlobalStore, ProjectStore } from "@sieve/core";
import { collect, original, PAGE, renderFrame, serveDashboard, whyCut } from "../src/index.ts";

let home: string;
let archiveId: string;
const ref = { key: "k1", root: "/tmp/demo", name: "demo", worktree: "/tmp/demo" };

beforeAll(() => {
  home = mkdtempSync("/tmp/sv-dash-");
  process.env.SIEVE_HOME = home;
  const gs = new GlobalStore();
  gs.touchProject(ref);
  gs.recordHook("claude-code", "PostToolUse", 1000, 3);
  gs.db.run(
    "INSERT INTO proxy_calls (at, provider, session, status, input_tokens, cache_read, cache_write, trimmed_bytes, folded, marks_added, dollars) VALUES (1, 'anthropic', 's', 200, 100, 800, 100, 3000, 2, 2, 0.5)",
  );
  gs.memory.remember(
    { subject: "api", predicate: "database", object: "postgres", writer: "user", at: 5 },
    { key: ref.key, root: ref.root, worktree: ref.worktree },
  );
  gs.close();
  const ps = new ProjectStore(ref);
  const original = "line one\n".repeat(400);
  const item = ps.put(original, {
    sessionId: "s1",
    worktree: ref.worktree,
    sourceKind: "tool",
    source: "Bash: bun test",
    at: 10,
  });
  archiveId = item.id;
  ps.recordFold({
    at: 20,
    sessionId: "s1",
    agent: "claude-code",
    tool: "Bash",
    kind: "fold",
    extractor: "bun-test",
    archiveId,
    tokensIn: 5000,
    tokensOut: 400,
    source: "Bash: bun test",
    canary: true,
  });
  ps.recordFold({
    at: 21,
    sessionId: "s1",
    agent: "claude-code",
    tool: "Read",
    kind: "rerun",
    extractor: null,
    archiveId,
    tokensIn: 1000,
    tokensOut: 100,
  });
  ps.recordFold({
    at: 22,
    sessionId: "s2",
    agent: "codex",
    tool: "Bash",
    kind: "pass",
    archiveId,
    tokensIn: 900,
    tokensOut: 900,
  });
  ps.db.close();
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("collecting", () => {
  test("totals count folds and reruns, not passes, and the dollar figure is labelled as a price you set", () => {
    const s = collect();
    expect(s.totals).toMatchObject({ folds: 2, tokensIn: 6000, tokensOut: 500, saved: 5500, savedPct: 92 });
    expect(s.dollars).toEqual({ saved: 0.02, perMillionInput: 3 });
    expect(s.cacheHitRate).toBe(0.8); // 800 read of 1000 input-side tokens
    expect(s.proxy).toEqual({
      calls: 1,
      trimmedBytes: 3000,
      folded: 2,
      archived: 0,
      marksAdded: 2,
      failedOpen: 0,
      dollars: 0.5,
    });
    expect(s.canaries).toBe(1);
  });

  test("breakdowns by agent, tool, extractor and session", () => {
    const s = collect();
    expect(s.byAgent.find((b) => b.key === "claude-code")).toMatchObject({
      count: 2,
      tokensIn: 6000,
      tokensOut: 500,
    });
    expect(s.byAgent.find((b) => b.key === "codex")).toBeUndefined(); // only a pass
    expect(s.byTool.map((b) => b.key).sort()).toEqual(["Bash", "Read"]);
    expect(s.byExtractor.map((b) => b.key).sort()).toEqual(["(none)", "bun-test"]);
    expect(s.bySession[0]!.key).toBe("demo: s1");
  });

  test("receipts carry a reason for each cut, newest first, with the archive id", () => {
    const s = collect();
    expect(s.receipts.map((r) => r.kind)).toEqual(["pass", "rerun", "fold"]);
    const fold = s.receipts.find((r) => r.kind === "fold")!;
    expect(fold.archiveId).toBe(archiveId);
    expect(fold.why).toContain("bun-test extractor kept 400 tokens");
    expect(fold.canary).toBe(true);
    expect(whyCut({ kind: "pass", extractor: null, tokensIn: 900, tokensOut: 900 })).toContain(
      "Left as it was",
    );
  });

  test("memory facts with their source, and hook health", () => {
    const s = collect();
    expect(s.facts[0]).toMatchObject({
      subject: "api",
      predicate: "database",
      object: "postgres",
      source: "user",
    });
    expect(s.hooks).toEqual([{ agent: "claude-code", event: "PostToolUse", lastAt: 1000, count: 3 }]);
    expect(s.projects[0]).toMatchObject({ name: "demo", archivedItems: 1 });
  });

  test("the original comes back exactly; bad ids are refused", () => {
    expect(original("k1", archiveId)?.text).toBe("line one\n".repeat(400));
    expect(original("k1", "s_zzzzzzzzzz")).toBeNull();
    expect(original("../../etc", archiveId)).toBeNull();
    expect(original("k1", "../x")).toBeNull();
  });
});

describe("the web server", () => {
  const d = serveDashboard();
  afterAll(() => d.stop());
  const get = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${d.port}${path}`, init);

  test("no token, wrong token, or a foreign Host header is refused", async () => {
    expect((await get("/api/snapshot")).status).toBe(401);
    expect((await get("/?t=nope")).status).toBe(401);
    expect((await get(`/?t=${d.token}`, { headers: { host: "evil.example" } })).status).toBe(403);
  });

  test("the right token serves the page and sets a cookie that works without it", async () => {
    const page = await get(`/?t=${d.token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const cookie = page.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const snap = await get("/api/snapshot", { headers: { cookie: cookie.split(";")[0]! } });
    expect(snap.status).toBe(200);
    expect(((await snap.json()) as { totals: { folds: number } }).totals.folds).toBe(2);
  });

  test("view original returns the archived text", async () => {
    const r = await get(`/api/original?p=k1&id=${archiveId}&t=${d.token}`);
    expect(r.status).toBe(200);
    expect((await r.text()).startsWith("line one")).toBe(true);
    expect((await get(`/api/original?p=k1&id=s_nothere&t=${d.token}`)).status).toBe(404);
  });

  test("the page loads nothing from outside and builds its tables from escaped text", () => {
    expect(PAGE).not.toMatch(/https?:\/\//);
    expect(PAGE).toContain("const esc=");
    expect(PAGE).not.toContain("eval(");
  });
});

describe("terminal view", () => {
  test("a frame shows the totals, receipts, guard, hooks and says the dollars are an estimate", () => {
    const f = renderFrame(collect(), { width: 100, daemon: { up: false } });
    expect(f).toContain("92% fewer");
    expect(f).toContain("(estimate)");
    expect(f).toContain("daemon not running");
    expect(f).toContain("claude-code");
    expect(f).toContain("fold/bun-test");
    expect(f).toContain("cache hits 80%");
    for (const line of f.split("\n")) expect(line.length).toBeLessThanOrEqual(140);
  });
});
