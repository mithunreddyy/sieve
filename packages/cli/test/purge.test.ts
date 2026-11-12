import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { ProjectStore, paths, resolveProject } from "@sieve/core";
import { purgeCommand } from "../src/purge.ts";

const MAIN = resolve(import.meta.dir, "../src/main.ts");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function sieve(home: string, cwd: string, args: string[]) {
  const p = Bun.spawn(["bun", MAIN, ...args], {
    cwd,
    env: { ...process.env, SIEVE_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

/** A SIEVE_HOME and a repo, with some archived items for two sessions already in its database. */
function project() {
  const home = mkdtempSync("/tmp/sv-pg-");
  const repo = realpathSync(mkdtempSync("/tmp/sv-pr-"));
  dirs.push(home, repo);
  const prev = process.env.SIEVE_HOME;
  process.env.SIEVE_HOME = home;
  mkdirSync(join(repo, ".git")); // a project root
  const ref = resolveProject(repo);
  const file = paths.projectDb(ref.key);
  mkdirSync(join(home, "projects", ref.key), { recursive: true });
  const store = new ProjectStore(ref, file);
  const body = (t: string) =>
    `${t}\n${Array.from({ length: 150 }, (_, i) => `row ${i} ${t} lorem ipsum`).join("\n")}`;
  const see = (t: string, session: string) => {
    const it = store.put(body(t), {
      sessionId: session,
      worktree: ref.worktree,
      agent: "claude-code",
      sourceKind: "tool",
      source: "Bash: x",
    });
    store.index(it.id);
    return it;
  };
  const a = see("ALPHA-MARK-91", "sess-a");
  const b = see("BRAVO-MARK-92", "sess-b");
  store.close();
  process.env.SIEVE_HOME = prev;
  return { home, repo, file, a, b, ref };
}
const open = (p: ReturnType<typeof project>) => new ProjectStore(p.ref, p.file);

describe("sieve purge", () => {
  test("a dry run, the default, says what would go and changes nothing", async () => {
    const p = project();
    const r = await sieve(p.home, p.repo, ["purge", "--session", "sess-a"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Would remove 1 archived item");
    expect(r.out).toContain("Nothing was changed");
    expect(r.out).toContain("--yes");
    const s = open(p);
    expect(s.get(p.a.id)).not.toBeNull();
    s.close();
  });

  test("--yes removes it, says it only after compacting, and the text is gone from the file", async () => {
    const p = project();
    expect(
      readFileSync(p.file).toString("latin1") +
        (existsSync(`${p.file}-wal`) ? readFileSync(`${p.file}-wal`).toString("latin1") : ""),
    ).toContain("ALPHA-MARK-91");
    const r = await sieve(p.home, p.repo, ["purge", "--session", "sess-a", "--yes"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Removed 1 archived item");
    expect(r.out).toContain("compacted");
    const raw =
      readFileSync(p.file).toString("latin1") +
      (existsSync(`${p.file}-wal`) ? readFileSync(`${p.file}-wal`).toString("latin1") : "");
    expect(raw).not.toContain("ALPHA-MARK-91");
    expect(raw).toContain("BRAVO-MARK-92");
    const s = open(p);
    expect(s.get(p.a.id)).toBeNull();
    expect(s.tombstone(p.a.id)?.reason).toBe("purge");
    expect(s.get(p.b.id)).not.toBeNull();
    s.close();
  }, 30_000);

  test("--project removes everything archived for this project", async () => {
    const p = project();
    const r = await sieve(p.home, p.repo, ["purge", "--project", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Removed 2 archived item");
    const s = open(p);
    expect([s.get(p.a.id), s.get(p.b.id)]).toEqual([null, null]);
    s.close();
  }, 30_000);

  test("--older-than removes what has not been read for that many days", async () => {
    const p = project();
    const s = open(p);
    s.db.run("UPDATE archive SET last_read_at = ? WHERE id = ?", [Date.now() - 90 * 86_400_000, p.a.id]);
    s.close();
    const dry = await sieve(p.home, p.repo, ["purge", "--older-than", "30"]);
    expect(dry.out).toContain("Would remove 1 archived item");
    const r = await sieve(p.home, p.repo, ["purge", "--older-than", "30", "--yes"]);
    expect(r.out).toContain("Removed 1 archived item");
    const s2 = open(p);
    expect(s2.get(p.a.id)).toBeNull();
    expect(s2.get(p.b.id)).not.toBeNull();
    s2.close();
  }, 30_000);

  test("it asks for exactly one scope, and refuses a nonsense number", async () => {
    const p = project();
    expect((await sieve(p.home, p.repo, ["purge"])).code).toBe(2);
    expect((await sieve(p.home, p.repo, ["purge", "--project", "--session", "x"])).code).toBe(2);
    const bad = await sieve(p.home, p.repo, ["purge", "--older-than", "soon"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("--older-than");
    const s = open(p);
    expect(s.get(p.a.id)).not.toBeNull(); // nothing was touched
    s.close();
  });

  test("the output says what it did not touch: memory, the proxy's archive, exports, sync, backups, logs, and the agent's own copies", async () => {
    const p = project();
    const r = await sieve(p.home, p.repo, ["purge", "--session", "sess-a", "--yes"]);
    for (const part of [
      "memory facts",
      "proxy's own archive",
      "exports",
      "backup of ~/.sieve",
      "Guard audit log",
      "daemon log",
      "transcript and tool-results",
    ])
      expect(r.out).toContain(part);
  }, 30_000);
});

const REPO = resolve(import.meta.dir, "../../..");
const SHIM = join(REPO, "dist", "sieve-hook");
const BIN = join(REPO, "dist", "sieve");
const built = existsSync(SHIM) && existsSync(BIN);

async function hook(home: string, repo: string) {
  const p = Bun.spawn([SHIM, "claude-code", "PostToolUse"], {
    stdin: Buffer.from(
      JSON.stringify({
        session_id: "race",
        cwd: repo,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_response: { stdout: "x", stderr: "", interrupted: false },
      }),
    ),
    stdout: "pipe",
    env: { ...process.env, SIEVE_HOME: home, SIEVE_BIN: BIN, SIEVE_HOOK_TIMEOUT_MS: "500" },
  });
  await new Response(p.stdout).text();
  await p.exited;
}

describe.if(built)("a purge is not raced by the next hook", () => {
  test("hooks that fire after the daemon stopped do not start one while the purge runs, and nothing is left paused", async () => {
    const p = project();
    const prev = process.env.SIEVE_HOME;
    process.env.SIEVE_HOME = p.home;
    const log = console.log;
    console.log = () => {};
    let socketDuringPurge = true;
    let lockHolder = "";
    try {
      const code = await purgeCommand(["--project", "--yes"], p.repo, {
        // the window between "daemon stopped" and "rows deleted": a burst of hooks, enough to trip the shim's spawn cap
        afterStop: async () => {
          for (let i = 0; i < 8; i++) await hook(p.home, p.repo);
          await Bun.sleep(1500); // any daemon they started would be up by now
          socketDuringPurge = existsSync(paths.socket());
          lockHolder = readFileSync(paths.lock(), "utf8").trim();
        },
      });
      expect(code).toBe(0);
    } finally {
      console.log = log;
      process.env.SIEVE_HOME = prev;
    }
    expect(socketDuringPurge).toBe(false); // no daemon came up behind the purge
    expect(lockHolder).toBe(String(process.pid)); // the purge held the lock the whole time
    expect(existsSync(join(p.home, "run", "sieved.lock"))).toBe(false); // and released it
    expect(existsSync(join(p.home, "run", "spawns"))).toBe(false); // the burst did not leave the shim paused for 5 minutes
    const s = open(p);
    expect([s.get(p.a.id), s.get(p.b.id)]).toEqual([null, null]);
    expect(s.db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    s.close();
    // the next hook starts a daemon as usual
    await hook(p.home, p.repo);
    for (let i = 0; i < 50 && !existsSync(join(p.home, "run", "sieved.sock")); i++) await Bun.sleep(100);
    expect(existsSync(join(p.home, "run", "sieved.sock"))).toBe(true);
    const stop = Bun.spawn([BIN, "daemon", "stop"], { env: { ...process.env, SIEVE_HOME: p.home } });
    await stop.exited;
    for (let i = 0; i < 50 && existsSync(join(p.home, "run", "sieved.lock")); i++) await Bun.sleep(100);
  }, 60_000);
});

describe("status and doctor say what the data policy is", () => {
  test("defaults: nothing is removed and nothing is fetched", async () => {
    const p = project();
    const r = await sieve(p.home, p.repo, ["doctor"]);
    expect(r.out).toContain("archive: kept until you run sieve purge (retention off)");
    expect(r.out).toContain("fetch: off: sieve_index does not fetch web pages");
  });
  test("when on, they say so, with the period and the hosts", async () => {
    const p = project();
    writeFileSync(
      join(p.home, "config.toml"),
      '[archive]\nretention_days = 45\n[fetch]\nenabled = true\nallow_hosts = ["docs.example.com"]\n',
    );
    const r = await sieve(p.home, p.repo, ["doctor"]);
    expect(r.out).toContain("items not read for 45 days are removed (retention on)");
    expect(r.out).toContain("ON: sieve_index may fetch https pages from docs.example.com only");
  });
});
