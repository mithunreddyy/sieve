import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveId,
  commandKey,
  compareRuns,
  countLines,
  decideRead,
  initOutlines,
  loadConfig,
  outline,
  ProjectStore,
  type ReadInput,
  type ReadRow,
} from "../src/index.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "sieve-s3-")));
const store = () => {
  const d = tmp();
  return new ProjectStore({ key: "k", root: d, name: "x", worktree: d }, join(d, "db"));
};

beforeAll(async () => {
  await initOutlines();
});

describe("outlines", () => {
  const names = (f: string, src: string) =>
    (outline(f, src) ?? []).map((s) => `${s.parent ? `${s.parent}.` : ""}${s.name}:${s.kind}`);
  test("TypeScript classes, methods, interfaces, types, arrow functions", () => {
    expect(
      names(
        "a.ts",
        "export class Router {\n  add(p: string) {\n    return p;\n  }\n}\ninterface Opts { a: number }\ntype Id = string;\nexport const make = (x: number) => x;\n",
      ),
    ).toEqual(["Router:class", "Router.add:method", "Opts:interface", "Id:type", "make:function"]);
  });
  test("top-level consts of any value are symbols; their methods nest under them", () => {
    const src =
      "export const make = () => 1;\nconst x = 5;\nexport const T: Extractor = {\n  id: 1,\n  run() {},\n};\nfunction g() { const inner = 1; }\n";
    expect(names("a.ts", src)).toEqual(["make:function", "x:const", "T:const", "T.run:method", "g:function"]);
  });
  test("Python, Go, Rust, Java (constructors are not Object.prototype.constructor)", () => {
    expect(names("a.py", "class Cart:\n    def total(self):\n        return 1\n")).toEqual([
      "Cart:class",
      "Cart.total:function",
    ]);
    expect(names("a.go", "package x\nfunc (c *Cart) Total() int {\n  return 1\n}\n")).toEqual([
      "Total:method",
    ]);
    expect(names("a.rs", "impl Cart {\n    fn total(&self) -> u32 { 1 }\n}\n")).toEqual([
      "Cart:impl",
      "Cart.total:function",
    ]);
    expect(names("A.java", "class Cart {\n  Cart() {}\n  int total() { return 1; }\n}\n")).toEqual([
      "Cart:class",
      "Cart.Cart:constructor",
      "Cart.total:method",
    ]);
  });
  test("Markdown headings nest; unsupported files have no outline", () => {
    expect(names("a.md", "# A\nx\n## B\ny\n```\n# not a heading\n```\n")).toEqual(["A:h1", "A.B:h2"]);
    expect(outline("data.csv", "a,b\n1,2\n")).toBeNull();
  });
});

const row = (over: Partial<ReadRow>): ReadRow => ({
  id: 1,
  path: "f.ts",
  kind: "full",
  contentId: "s_x",
  size: 1,
  mtimeMs: 1,
  readNo: 1,
  epoch: 0,
  createdAt: 0,
  ...over,
});
function input(text: string, over: Partial<ReadInput> = {}): ReadInput {
  return {
    path: "src/f.ts",
    text,
    state: { size: Buffer.byteLength(text), mtimeMs: 1, contentId: archiveId(text) },
    tokens: 1000,
    last: null,
    lastText: null,
    symbols: outline("f.ts", text),
    outlineAboveBytes: 16 * 1024,
    again: "read it again",
    rangeHint: (a, b) => `Read with offset ${a} and limit ${b - a + 1}`,
    ...over,
  };
}
const big = Array.from(
  { length: 600 },
  (_, i) => `export function handler${i}(req: Request) {\n  return limitRate(req, ${i});\n}`,
).join("\n");

describe("smart reads", () => {
  test("small new file: send it whole", () => {
    expect(decideRead(input("const a = 1;\n")).kind).toBe("full");
  });
  test("unchanged since a full read by this reader", () => {
    const t = "const a = 1;\n";
    const d = decideRead(input(t, { last: row({ contentId: archiveId(t), readNo: 3 }) }));
    expect(d.kind).toBe("unchanged");
    if (d.kind !== "full") expect(d.message).toContain("unchanged since your read #3");
  });
  test("never claims 'unchanged' after only a partial read or an outline", () => {
    const t = "const a = 1;\n";
    expect(decideRead(input(t, { last: row({ contentId: archiveId(t), kind: "partial" }) })).kind).toBe(
      "full",
    );
    expect(decideRead(input(t, { last: row({ contentId: archiveId(t), kind: "outline" }) })).kind).toBe(
      "full",
    );
  });
  test("changed: only the hunks, with the new line numbers", () => {
    const before = big;
    const after = big.replace("return limitRate(req, 300);", "return limitRate(req, 301); // tuned");
    const d = decideRead(
      input(after, { last: row({ contentId: archiveId(before), readNo: 2 }), lastText: before }),
    );
    expect(d.kind).toBe("changed");
    if (d.kind === "full") return;
    expect(d.message).toContain("changed since your read #2 (+1 −1 lines in 1 hunk)");
    expect(d.message).toContain("+  return limitRate(req, 301); // tuned");
    expect(d.message).toContain("@@ -900,");
    expect(d.message.length).toBeLessThan(1000);
  });
  test("a large rewrite is not shown as a diff", () => {
    const before = "x\n".repeat(50);
    const after = "y\n".repeat(50);
    expect(
      decideRead(input(after, { last: row({ contentId: archiveId(before) }), lastText: before })).kind,
    ).toBe("full");
  });
  test("large file: outline plus the lines matching the intent, and how to get more", () => {
    const d = decideRead(input(big, { intent: "where is handler417 rate limited?" }));
    expect(d.kind).toBe("outline");
    if (d.kind === "full") return;
    expect(d.message).toContain("1,800 lines");
    expect(d.message).toContain("export function handler0(req: Request) {");
    expect(d.message).toContain("1253│   return limitRate(req, 417);");
    expect(d.message).toContain("Read with offset 1252 and limit 3");
    expect(d.message).toMatch(
      /Read with offset \d+ and limit \d+ for the part you need, or read it again for the whole file \(1,000 tokens\)/,
    );
    expect(Buffer.byteLength(d.message)).toBeLessThan(12 * 1024);
    expect(decideRead(input(big, { intent: "where is handler417 rate limited?" }))).toEqual(d); // deterministic
  });
  test("unknown token count shows the size instead of a guess", () => {
    const d = decideRead(input(big, { tokens: null }));
    if (d.kind !== "full") expect(d.message).toContain(`${Math.round(Buffer.byteLength(big) / 1024)} KB`);
  });
});

describe("reruns", () => {
  const item = (t: string) => ({
    id: archiveId(t),
    bytes: t.length,
    tokens: 100,
    tokenizer: "o200k_base",
    lines: countLines(t),
    isNew: true,
  });
  test("command keys ignore spacing", () => {
    expect(commandKey("  npm   test \n")).toBe("npm test");
  });
  test("identical output: one line pointing at the earlier run", () => {
    const t = "x".repeat(2000);
    const r = compareRuns({ runNo: 2, item: item(t), text: t }, item(t), t, {
      command: "make",
      isError: false,
    });
    expect(r.kind).toBe("identical");
    if (r.kind === "identical") expect(r.text).toContain("Same output as run #2 of this command");
  });
  test("test runs: fixed, new, still failing", () => {
    const before = readFileSync(join(import.meta.dir, "../fixtures/go-test/panic.txt"), "utf8");
    const after = before.replace(
      "--- FAIL: TestDiscountAppliedOnce (0.00s)\n    cart_test.go:20: Total() = 81, want 90\n",
      "--- FAIL: TestNewThing (0.00s)\n    new_test.go:3: broke\n",
    );
    const r = compareRuns({ runNo: 1, item: item(before), text: before }, item(after), after, {
      command: "go test ./...",
      isError: false,
    });
    expect(r.kind).toBe("summary");
    if (r.kind === "summary") {
      expect(r.preface).toContain("vs run #1 of this command");
      expect(r.preface).toContain("1 fixed, 1 new, 1 still failing");
      expect(r.preface).toContain("fixed: TestDiscountAppliedOnce");
      expect(r.preface).toContain("new: TestNewThing");
    }
  });
  test("small change in other output: only the changed lines", () => {
    const before = Array.from({ length: 200 }, (_, i) => `row ${i} ok`).join("\n");
    const after = before.replace("row 120 ok", "row 120 FAILED");
    const r = compareRuns({ runNo: 1, item: item(before), text: before }, item(after), after, {
      command: "./check.sh",
      isError: false,
    });
    expect(r.kind).toBe("diff");
    if (r.kind === "diff") {
      expect(r.text).toContain("+1 −1 lines");
      expect(r.text).toContain("+row 120 FAILED");
    }
  });
});

describe("ledgers", () => {
  test("reads are per reader context and per epoch", () => {
    const s = store();
    s.touchSession("s1", "a", "/w");
    const main = { sessionId: "s1", context: "main" };
    const sub = { sessionId: "s1", context: "sub:abc" };
    const f = { size: 1, mtimeMs: 1, contentId: "s_a" };
    expect(s.recordRead(main, "/w", "a.ts", "full", f)).toBe(1);
    expect(s.recordRead(main, "/w", "a.ts", "full", f)).toBe(2);
    expect(s.lastRead(main, "/w", "a.ts")?.readNo).toBe(2);
    expect(s.lastRead(sub, "/w", "a.ts")).toBeNull();
    s.bumpEpoch("s1");
    expect(s.lastRead(main, "/w", "a.ts")).toBeNull();
    expect(s.readsInEpoch(main, "/w")).toEqual([]);
  });
  test("runs are numbered and forgotten after compaction", () => {
    const s = store();
    s.touchSession("s1", "a", "/w");
    const r = { sessionId: "s1", context: "main" };
    s.recordRun(r, "/w", "npm test", "s_1");
    s.recordRun(r, "/w", "npm test", "s_2");
    expect(s.lastRun(r, "/w", "npm test")).toEqual({ archiveId: "s_2", runNo: 2 });
    s.bumpEpoch("s1");
    expect(s.lastRun(r, "/w", "npm test")).toBeNull();
  });
  test("symbol search ranks exact names first", () => {
    const s = store();
    const f = { size: 1, mtimeMs: 1, contentId: "s_a", lines: 9, lang: "typescript", tokens: 5 };
    s.putFile(
      "/w",
      "a.ts",
      f,
      outline("a.ts", "function rateLimit() {}\nfunction rateLimitConfig() {}\nclass Limiter {}\n"),
    );
    expect(s.findSymbols("/w", ["ratelimit"]).map((x) => x.name)).toEqual(["rateLimit", "rateLimitConfig"]);
    s.deleteFile("/w", "a.ts");
    expect(s.findSymbols("/w", ["ratelimit"])).toEqual([]);
  });
});

describe("config", () => {
  test("defaults, file values, env overrides, and unknown keys rejected", () => {
    const d = tmp();
    expect(loadConfig(join(d, "none.toml")).reads.smart).toBe(true);
    writeFileSync(join(d, "c.toml"), "[reads]\nsmart = false\noutline_above_kb = 32\n");
    expect(loadConfig(join(d, "c.toml")).reads).toEqual({ smart: false, outline_above_kb: 32 });
    process.env.SIEVE_SMART_READS = "1";
    expect(loadConfig(join(d, "c.toml")).reads.smart).toBe(true);
    delete process.env.SIEVE_SMART_READS;
    writeFileSync(join(d, "bad.toml"), "[reads]\nsmrt = true\n");
    expect(() => loadConfig(join(d, "bad.toml"))).toThrow();
  });
});

describe("intent from real prompts", () => {
  const prompt =
    "<ide_opened_file>The user opened the file /Users/x/proj/config.ts in the IDE. This may or may not be related to the current task.</ide_opened_file>fix the bugs in the rate limiter";
  test("harness tags are removed and stopwords dropped", async () => {
    const { cleanPrompt, intentTerms } = await import("../src/index.ts");
    expect(cleanPrompt(prompt)).toBe("fix the bugs in the rate limiter");
    expect(intentTerms(prompt)).toEqual(["rate", "limiter"]);
    expect(intentTerms("<system-reminder>be careful</system-reminder>")).toEqual([]);
    expect(intentTerms("handler417 on port 8080", true)).toEqual(["handler417", "port", "8080"]);
  });
  test("an outline reply for a noisy prompt matches on the real words only", () => {
    const text = Array.from(
      { length: 400 },
      (_, i) => `function f${i}() {\n  // the user opened this file\n  return ${i};\n}`,
    )
      .join("\n")
      .replace("return 200;", "return rateLimiter(200);");
    const d = decideRead(input(text, { intent: prompt }));
    expect(d.kind).toBe("outline");
    if (d.kind === "full") return;
    expect(d.message).toContain("lines matching your request (rate, limiter):");
    expect(d.message).toContain("rateLimiter(200)");
    expect(d.message).toContain("lines 801-804:"); // the enclosing function, and only that
    expect(d.message.split("lines matching your request")[1]!.match(/lines \d+-\d+:/g)).toHaveLength(1);
  });
});
