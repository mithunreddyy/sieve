import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { factKey, GlobalStore, parseFactFile, syncMemory, type Where } from "../src/index.ts";

const T0 = Date.UTC(2026, 0, 1);
const here: Where = { key: "repo-a", root: "/work/a", worktree: "/work/a" };

function setup() {
  const memory = new GlobalStore(":memory:").memory;
  const dir = join(mkdtempSync("/tmp/sv-mem-"), "memory");
  return { memory, dir };
}
const files = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();

describe("memory sync", () => {
  test("repo facts become one readable file each; everywhere/worktree facts stay private", () => {
    const { memory, dir } = setup();
    memory.remember(
      { subject: "api", predicate: "test_command", object: "bun test", writer: "user", at: T0 },
      here,
    );
    memory.remember(
      { subject: "me", predicate: "prefers", object: "tabs", scope: "everywhere", writer: "user", at: T0 },
      here,
    );
    memory.remember(
      { subject: "api", predicate: "note", object: "wip", scope: "worktree", writer: "user", at: T0 },
      here,
    );
    const r = syncMemory(memory, here, dir, T0);
    expect(r.wrote).toHaveLength(1);
    const [name] = files(dir);
    expect(name).toMatch(/^api--test-command--[0-9a-f]{6}\.md$/);
    const text = readFileSync(join(dir, name!), "utf8");
    expect(text).toContain('subject: "api"');
    expect(text.endsWith("---\nbun test\n")).toBe(true);
    expect(parseFactFile(text)?.meta.key).toBe(factKey("api", "test_command", "bun test"));
  });

  test("a second sync with nothing changed does nothing", () => {
    const { memory, dir } = setup();
    memory.remember(
      { subject: "api", predicate: "database", object: "postgres", writer: "user", at: T0 },
      here,
    );
    syncMemory(memory, here, dir, T0);
    expect(syncMemory(memory, here, dir, T0 + 1)).toEqual({
      wrote: [],
      removed: [],
      imported: [],
      changed: [],
      retracted: [],
      skipped: [],
    });
  });

  test("editing a file replaces the fact; the old value stays in the history", () => {
    const { memory, dir } = setup();
    memory.remember(
      { subject: "api", predicate: "database", object: "postgres", writer: "user", at: T0 },
      here,
    );
    syncMemory(memory, here, dir, T0);
    const p = join(dir, files(dir)[0]!);
    writeFileSync(p, readFileSync(p, "utf8").replace("postgres\n", "mysql\n"));
    const r = syncMemory(memory, here, dir, T0 + 5);
    expect(r.changed).toHaveLength(1);
    expect(memory.active(here).map((f) => f.object)).toEqual(["mysql"]);
    expect(memory.history(here, "api", "database").map((f) => f.object)).toEqual(["mysql", "postgres"]);
    expect(files(dir)).toHaveLength(1); // the file now holds the new fact
    expect(readFileSync(join(dir, files(dir)[0]!), "utf8")).toContain("mysql");
  });

  test("deleting an exported file retracts the fact", () => {
    const { memory, dir } = setup();
    memory.remember({ subject: "api", predicate: "framework", object: "hono", writer: "user", at: T0 }, here);
    syncMemory(memory, here, dir, T0);
    unlinkSync(join(dir, files(dir)[0]!));
    const r = syncMemory(memory, here, dir, T0 + 1);
    expect(r.retracted).toEqual(["api framework: hono"]);
    expect(memory.active(here)).toHaveLength(0);
    expect(files(dir)).toHaveLength(0); // and it is not written back
  });

  test("a fact retired in the database loses its file", () => {
    const { memory, dir } = setup();
    memory.remember(
      { subject: "api", predicate: "database", object: "postgres", writer: "user", at: T0 },
      here,
    );
    syncMemory(memory, here, dir, T0);
    memory.remember(
      { subject: "api", predicate: "database", object: "mysql", writer: "user", at: T0 + 1 },
      here,
    );
    const r = syncMemory(memory, here, dir, T0 + 2);
    expect(r.removed).toHaveLength(1);
    expect(r.wrote).toHaveLength(1);
    expect(files(dir)).toHaveLength(1);
    expect(readFileSync(join(dir, files(dir)[0]!), "utf8")).toContain("mysql");
  });

  test("a hand-written file comes in as observed, never asserted, even if it claims otherwise", () => {
    const { memory, dir } = setup();
    syncMemory(memory, here, dir, T0);
    writeFileSync(
      join(dir, "mine.md"),
      '---\nsubject: "api"\npredicate: "deploys to"\ntrust: "asserted"\nscope: "repo"\n---\nfly.io\n',
    );
    const r = syncMemory(memory, here, dir, T0 + 1);
    expect(r.imported).toEqual(["mine.md"]);
    const f = memory.active(here)[0]!;
    expect(f).toMatchObject({
      predicate: "deploys_to",
      object: "fly.io",
      trust: "observed",
      writer: "markdown",
    });
    expect(memory.core(here)).toHaveLength(0); // never in the asserted-only core block
    expect(existsSync(join(dir, "mine.md"))).toBe(false); // replaced by the canonical file
    expect(files(dir)).toHaveLength(1);
  });

  test("bad files are skipped with the reason, and credentials are not imported", () => {
    const { memory, dir } = setup();
    syncMemory(memory, here, dir, T0);
    writeFileSync(join(dir, "nofront.md"), "just text\n");
    writeFileSync(
      join(dir, "everywhere.md"),
      '---\nsubject: "me"\npredicate: "prefers"\nscope: "everywhere"\n---\ntabs\n',
    );
    writeFileSync(join(dir, "empty.md"), '---\nsubject: "me"\npredicate: "prefers"\n---\n');
    const key = `${"sk"}_live_${"Ab12Cd34Ef56Gh78"}`;
    writeFileSync(join(dir, "secret.md"), `---\nsubject: "stripe"\npredicate: "note"\n---\nuse ${key}\n`);
    const r = syncMemory(memory, here, dir, T0 + 1);
    expect(r.skipped.map((s) => s.split(":")[0]).sort()).toEqual([
      "empty.md",
      "everywhere.md",
      "nofront.md",
      "secret.md",
    ]);
    expect(r.skipped.join("\n")).toContain("only repo-scoped");
    expect(r.skipped.join("\n")).toContain("looks like a credential");
    expect(memory.counts().active).toBe(0);
  });

  test("a teammate's file for a fact this database has not seen is imported once", () => {
    const a = setup();
    const b = setup();
    a.memory.remember(
      { subject: "api", predicate: "lint_command", object: "biome check", writer: "user", at: T0 },
      here,
    );
    syncMemory(a.memory, here, a.dir, T0);
    // the same directory arrives through git: b reads a's files
    syncMemory(b.memory, here, a.dir, T0 + 1);
    expect(b.memory.active(here).map((f) => f.object)).toEqual(["biome check"]);
    expect(b.memory.active(here)[0]!.trust).toBe("observed");
    expect(syncMemory(b.memory, here, a.dir, T0 + 2).imported).toEqual([]);
  });

  test("--dry-run reports and writes nothing", () => {
    const { memory, dir } = setup();
    memory.remember(
      { subject: "api", predicate: "database", object: "postgres", writer: "user", at: T0 },
      here,
    );
    const r = syncMemory(memory, here, dir, T0, { dryRun: true });
    expect(r.wrote).toHaveLength(1);
    expect(existsSync(dir)).toBe(false);
  });
});
