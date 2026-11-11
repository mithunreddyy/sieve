import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const MAIN = resolve(import.meta.dir, "../src/main.ts");
let home: string;
let src: string;

beforeAll(() => {
  home = mkdtempSync("/tmp/sv-cli-");
  src = mkdtempSync("/tmp/sv-skill-src-");
  writeFileSync(
    join(src, "SKILL.md"),
    "---\nname: tdd\ndescription: Test driven development: write the failing test first\n---\nRed, green, refactor.\n",
  );
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(src, { recursive: true, force: true });
});

async function sieve(...args: string[]) {
  const p = Bun.spawn(["bun", MAIN, "skills", ...args], {
    env: { ...process.env, SIEVE_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

describe("sieve skills", () => {
  test("add → list → enable → match → disable → remove", async () => {
    const add = await sieve("add", src);
    expect(add.code).toBe(0);
    expect(add.out).toContain("Added tdd (disabled)");
    expect(add.out).toContain("never runs anything in a skill");
    expect((await sieve("match", "use the tdd skill")).out).toBe("No skill would load.\n"); // not enabled yet
    expect((await sieve("enable", "tdd")).out).toContain("tdd: enabled");
    expect((await sieve("match", "use the tdd skill")).out).toContain(
      "tdd would load: you asked for it by name.",
    );
    const list = await sieve("list");
    expect(list.out).toMatch(/^on {2}tdd/);
    expect(list.out).toMatch(/costs about \d+ token/);
    expect((await sieve("disable", "tdd")).out).toContain("disabled");
    expect((await sieve("remove", "tdd")).out).toContain("Removed tdd.");
    expect((await sieve("list")).out).toContain("No skills.");
  });

  test("tampering is reported by verify and blocks enabling", async () => {
    await sieve("add", src);
    writeFileSync(
      join(home, "skills", "tdd", "files", "SKILL.md"),
      "---\nname: tdd\ndescription: x\n---\nchanged\n",
    );
    const v = await sieve("verify");
    expect(v.code).toBe(1);
    expect(v.out).toContain("files changed since import");
    const en = await sieve("enable", "tdd");
    expect(en.code).toBe(1);
    expect(en.err).toContain("not enabled");
  });

  test("a bad source and a missing argument say what is wrong", async () => {
    expect((await sieve("add", "/no/such/folder")).err).toContain("not a folder or a git URL");
    expect((await sieve("add")).code).toBe(2);
    expect((await sieve("enable", "ghost")).err).toContain("no skill named ghost");
  });
});
