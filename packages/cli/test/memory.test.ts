import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { GlobalStore, resolveProject } from "@sieve/core";

const MAIN = resolve(import.meta.dir, "../src/main.ts");
let home: string;
let repo: string;

beforeAll(() => {
  home = mkdtempSync("/tmp/sv-cli-");
  repo = join(home, "repo");
  mkdirSync(repo, { recursive: true });
  repo = realpathSync(repo);
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

async function sieve(...args: string[]) {
  const p = Bun.spawn(["bun", MAIN, "memory", ...args], {
    cwd: repo,
    env: { ...process.env, SIEVE_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

function seed(f: (m: GlobalStore["memory"], where: { key: string; root: string; worktree: string }) => void) {
  process.env.SIEVE_HOME = home;
  const gs = new GlobalStore(join(home, "global.db"));
  const ref = resolveProject(repo);
  f(gs.memory, { key: ref.key, root: ref.root, worktree: ref.worktree });
  gs.close();
}

describe("sieve memory", () => {
  test("list, then edit replaces and keeps history, then retract", async () => {
    seed((m, w) => {
      m.remember({ subject: "api", predicate: "database", object: "postgres", writer: "user", at: 1000 }, w);
    });
    const list = await sieve("list");
    expect(list.out).toMatch(/#1 api database: postgres {2}\[repo, asserted, /);
    const edit = await sieve("edit", "1", "--object", "mysql");
    expect(edit.code).toBe(0);
    const now = await sieve("list");
    expect(now.out).toContain("api database: mysql");
    expect(now.out).not.toContain("postgres");
    const hist = await sieve("list", "api", "--history");
    expect(hist.out).toContain("postgres");
    expect(hist.out).toContain("(closed ");
    const gone = await sieve("edit", "2", "--retract");
    expect(gone.out).toContain("Retracted #2");
    expect((await sieve("list")).out).toContain("No stored facts here.");
    expect((await sieve("edit", "2", "--retract")).code).toBe(1); // already closed
  });

  test("a credential in an edit changes nothing", async () => {
    seed((m, w) => {
      m.remember({ subject: "web", predicate: "framework", object: "hono", writer: "user", at: 1000 }, w);
    });
    const id = (await sieve("list", "web", "--json")).out.match(/"id": (\d+)/)![1]!;
    const key = `${"sk"}_live_${"Ab12Cd34Ef56Gh78"}`;
    const r = await sieve("edit", id, "--object", `use ${key}`);
    expect(r.code).toBe(1);
    expect(r.err).toContain("looks like a credential");
    expect((await sieve("list", "web")).out).toContain("hono");
  });

  test("review lists what is not asserted and what may be a duplicate", async () => {
    seed((m, w) => {
      m.remember({ subject: "svc", predicate: "prefers", object: "bun", writer: "user", at: 1 }, w);
      m.remember({ subject: "svc", predicate: "avoids", object: "bun", writer: "rule", at: 1 }, w);
    });
    const r = await sieve("review");
    expect(r.out).toContain("Possible duplicates");
    expect(r.out).toContain("different predicates, same value");
    expect(r.out).toContain("Not asserted by you (1)");
  });

  test("sync writes files into the repo, reads edits back, and --dry-run touches nothing", async () => {
    const dir = join(repo, ".sieve", "memory");
    const dry = await sieve("sync", "--dry-run");
    expect(dry.out).toContain("would write");
    expect(existsSync(dir)).toBe(false);
    const real = await sieve("sync");
    expect(real.out).toContain("Memory files are in");
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    expect((await sieve("sync")).out).toContain("Already in sync");
    expect(readFileSync(join(dir, files[0]!), "utf8").startsWith("---\n")).toBe(true);
  });

  test("prune asks first, and never touches active facts", async () => {
    const dry = await sieve("prune", "--days", "0");
    expect(dry.out).toContain("Re-run with --yes");
    const done = await sieve("prune", "--days", "0", "--yes");
    expect(done.out).toMatch(/Deleted \d+ closed fact/);
    expect((await sieve("list")).out).toContain("hono");
  });
});
