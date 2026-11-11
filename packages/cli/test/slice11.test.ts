import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { GlobalStore, ProjectStore, resolveProject } from "@sieve/core";
import { installService, planService, type Runner, uninstallService } from "../src/service.ts";
import { checksumFor, replaceBinary, sha256 } from "../src/upgrade.ts";

const MAIN = resolve(import.meta.dir, "../src/main.ts");
const dirs: string[] = [];
const tmp = (p: string) => {
  const d = realpathSync(mkdtempSync(`/tmp/${p}`));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function sieve(home: string, cwd: string, args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(["bun", MAIN, ...args], {
    cwd,
    env: { ...process.env, SIEVE_HOME: home, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

describe("login service", () => {
  test("a launchd agent that starts the daemon at login and is restarted after a crash, with a throttle", () => {
    const p = planService({
      platform: "darwin",
      bin: "/opt/sieve & co/sieve",
      home: "/Users/me",
      sieveHome: "/Users/me/.sieve",
      uid: 501,
    });
    expect(p.file).toBe("/Users/me/Library/LaunchAgents/dev.sieve.daemon.plist");
    expect(p.content).toContain(
      "<string>/opt/sieve &amp; co/sieve</string><string>daemon</string><string>run</string>",
    );
    expect(p.content).toContain("<key>RunAtLoad</key><true/>");
    expect(p.content).toContain("<key>SuccessfulExit</key><false/>");
    expect(p.content).toContain("<key>ThrottleInterval</key><integer>30</integer>");
    expect(p.content).toContain("<key>SIEVE_IDLE_MINUTES</key><string>0</string>");
    expect(p.install).toEqual([["launchctl", "bootstrap", "gui/501", p.file!]]);
    expect(p.uninstall).toEqual([["launchctl", "bootout", "gui/501/dev.sieve.daemon"]]);
  });

  test("a systemd user unit with a start limit, and a Windows logon task", () => {
    const l = planService({
      platform: "linux",
      bin: "/usr/local/bin/sieve",
      home: "/home/me",
      sieveHome: "/home/me/.sieve",
    });
    expect(l.file).toBe("/home/me/.config/systemd/user/sieve.service");
    expect(l.content).toContain('ExecStart="/usr/local/bin/sieve" daemon run');
    expect(l.content).toContain("StartLimitBurst=5");
    expect(l.content).toContain("Restart=on-failure");
    expect(l.install[1]).toEqual(["systemctl", "--user", "enable", "--now", "sieve.service"]);
    const w = planService({
      platform: "win32",
      bin: "C:\\sieve\\sieve.exe",
      home: "C:\\Users\\me",
      sieveHome: "x",
    });
    expect(w.file).toBeNull();
    expect(w.install[0]).toContain("ONLOGON");
    expect(() => planService({ platform: "freebsd", bin: "x", home: "x", sieveHome: "x" })).toThrow(
      "no login service",
    );
  });

  test("install writes the file and runs the commands (through a fake runner); uninstall removes it", () => {
    const home = tmp("sv-svc-");
    const calls: string[] = [];
    const run: Runner = (c, a) => {
      calls.push([c, ...a].join(" "));
    };
    const plan = planService({
      platform: "darwin",
      bin: "/x/sieve",
      home,
      sieveHome: join(home, ".sieve"),
      uid: 501,
    });
    const did = installService(plan, run);
    expect(existsSync(plan.file!)).toBe(true);
    expect(readFileSync(plan.file!, "utf8")).toContain("dev.sieve.daemon");
    expect(calls).toEqual([`launchctl bootstrap gui/501 ${plan.file}`]);
    expect(did[0]).toContain("wrote");
    const undone = uninstallService(plan, () => {
      throw new Error("service not loaded");
    });
    expect(existsSync(plan.file!)).toBe(false); // the file goes even when launchctl complains
    expect(undone.join("\n")).toContain("service not loaded");
  });

  test("--dry-run through the real command prints the plan and writes nothing", async () => {
    const home = tmp("sv-svc-");
    const fake = join(home, "sieve");
    writeFileSync(fake, "#!/bin/sh\n", { mode: 0o755 });
    const r = await sieve(home, home, ["service", "install", "--dry-run"], { SIEVE_BIN: fake });
    expect(r.code).toBe(0);
    expect(r.out).toContain(process.platform === "darwin" ? "dev.sieve.daemon" : "sieve.service");
    expect(r.out).toContain("$ ");
    expect((await sieve(home, home, ["service", "install"], { SIEVE_BIN: "" })).code).toBe(1); // from source: no fixed path
  });
});

describe("upgrade checksum file", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  test("a bare hash is used as is", () => {
    expect(checksumFor(`${a}\n`, "/x/sieve")).toBe(a);
  });
  test("a SHA256SUMS file: the line naming the downloaded file wins, not the first line", () => {
    const sums = `${a}  sieve-0.1.0-darwin-arm64.tar.gz\n${b}  sieve-darwin-arm64\n`;
    expect(checksumFor(sums, "https://h/releases/download/v0.1.0/sieve-darwin-arm64")).toBe(b);
    expect(checksumFor(sums.replace("  ", " *"), "./sieve-0.1.0-darwin-arm64.tar.gz")).toBe(a);
  });
  test("several lines and none names the file: refused instead of guessing", () => {
    expect(() => checksumFor(`${a}  one\n${b}  two\n`, "/x/three")).toThrow("three");
  });
});

describe("upgrade", () => {
  const script = (version: string) =>
    `#!/bin/sh\nif [ "$1" = "version" ]; then echo "sieve ${version}"; fi\nexit 0\n`;
  function installed() {
    const d = tmp("sv-up-");
    const target = join(d, "sieve");
    writeFileSync(target, script("0.1.0"), { mode: 0o755 });
    const next = join(d, "sieve-new");
    writeFileSync(next, script("0.2.0"), { mode: 0o755 });
    return { d, target, next, sum: sha256(readFileSync(next)) };
  }

  test("a verified binary replaces the old one, which is kept as .prev", async () => {
    const { target, next, sum } = installed();
    const r = await replaceBinary({ from: next, expectSha256: sum, target });
    expect(r.version).toBe("0.2.0");
    expect(readFileSync(target, "utf8")).toContain("0.2.0");
    expect(readFileSync(`${target}.prev`, "utf8")).toContain("0.1.0");
    expect(existsSync(join(resolve(target, ".."), `.sieve-upgrade-${process.pid}`))).toBe(false);
  });

  test("a wrong checksum changes nothing", async () => {
    const { target, next } = installed();
    await expect(replaceBinary({ from: next, expectSha256: "0".repeat(64), target })).rejects.toThrow(
      "checksum mismatch",
    );
    expect(readFileSync(target, "utf8")).toContain("0.1.0");
    expect(existsSync(`${target}.prev`)).toBe(false);
  });

  test("a file that does not run and report a version is refused before the swap", async () => {
    const { d, target } = installed();
    const broken = join(d, "broken");
    writeFileSync(broken, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    await expect(replaceBinary({ from: broken, target })).rejects.toThrow("did not run and report a version");
    const notBinary = join(d, "text");
    writeFileSync(notBinary, "just text");
    chmodSync(notBinary, 0o644);
    await expect(replaceBinary({ from: notBinary, target })).rejects.toThrow();
    expect(readFileSync(target, "utf8")).toContain("0.1.0");
  });

  test("a download must come with a checksum, only https is accepted, and the bytes are checked", async () => {
    const { target, next, sum } = installed();
    const bytes = readFileSync(next);
    const fake = (async () => new Response(bytes)) as unknown as typeof fetch;
    await expect(
      replaceBinary({ from: "https://example.test/sieve", target, fetchImpl: fake }),
    ).rejects.toThrow("needs --sha256");
    await expect(
      replaceBinary({ from: "http://example.test/sieve", expectSha256: sum, target }),
    ).rejects.toThrow("only https");
    await expect(
      replaceBinary({
        from: "https://example.test/sieve",
        expectSha256: "f".repeat(64),
        target,
        fetchImpl: fake,
      }),
    ).rejects.toThrow("checksum mismatch");
    const ok = await replaceBinary({
      from: "https://example.test/sieve",
      expectSha256: sum,
      target,
      fetchImpl: fake,
    });
    expect(ok.version).toBe("0.2.0");
    const notFound = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    await expect(
      replaceBinary({ from: "https://example.test/x", expectSha256: sum, target, fetchImpl: notFound }),
    ).rejects.toThrow("HTTP 404");
  });
});

describe("moving a session and syncing, through the real commands", () => {
  function machine(name: string) {
    const home = tmp(`sv-${name}-h-`);
    const repo = tmp(`sv-${name}-r-`);
    mkdirSync(join(repo, ".git"));
    writeFileSync(
      join(repo, ".git", "config"),
      '[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n',
    );
    return { home, repo };
  }
  function seedSession(m: { home: string; repo: string }) {
    process.env.SIEVE_HOME = m.home;
    const ref = resolveProject(m.repo);
    const gs = new GlobalStore();
    gs.touchProject(ref);
    gs.memory.remember(
      { subject: "api", predicate: "database", object: "postgres", scope: "repo", writer: "user", at: 1 },
      { key: ref.key, root: ref.root, worktree: ref.worktree },
    );
    gs.close();
    const store = new ProjectStore(ref);
    store.touchSession("sess-9", "claude-code", ref.worktree, 10);
    store.log.append("sess-9", {
      kind: "prompt",
      context: "main",
      worktree: ref.worktree,
      summary: "refactor the limiter",
      key: "request",
      at: 11,
    });
    store.db.run("UPDATE sessions SET ended_at = 20 WHERE id = 'sess-9'");
    store.db.close();
  }

  test("export to a file and import on another machine, plain and encrypted", async () => {
    const a = machine("a");
    const b = machine("b");
    seedSession(a);
    const out = join(a.home, "s.json.gz");
    const ex = await sieve(a.home, a.repo, ["session", "export", "sess-9", "-o", out]);
    expect(ex.code).toBe(0);
    expect(ex.out).toContain("Not encrypted");
    const im = await sieve(b.home, b.repo, ["session", "import", out]);
    expect(im.out).toContain("Imported session sess-9: 1 log row(s)");
    expect((await sieve(b.home, b.repo, ["session", "list"])).out).toContain("sess-9");
    expect((await sieve(b.home, b.repo, ["session", "import", out])).err).toContain("already exists");

    const enc = join(a.home, "s.enc");
    const e = await sieve(a.home, a.repo, ["session", "export", "sess-9", "-o", enc, "--encrypt"], {
      SIEVE_PASSPHRASE: "long enough passphrase",
    });
    expect(e.out).toContain("encrypted");
    expect(readFileSync(enc).includes(Buffer.from("refactor the limiter"))).toBe(false);
    const c = machine("c");
    expect((await sieve(c.home, c.repo, ["session", "import", enc])).err).toContain("encrypted");
    expect(
      (await sieve(c.home, c.repo, ["session", "import", enc], { SIEVE_PASSPHRASE: "the wrong passphrase" }))
        .err,
    ).toContain("wrong passphrase");
    expect(
      (
        await sieve(c.home, c.repo, ["session", "import", enc], {
          SIEVE_PASSPHRASE: "long enough passphrase",
        })
      ).out,
    ).toContain("Imported session sess-9");
    expect((await sieve(a.home, a.repo, ["session", "export", "sess-9", "--encrypt"])).code).toBe(2); // no passphrase given
  });

  test("sync push from one machine, pull on another", async () => {
    const a = machine("a");
    const b = machine("b");
    seedSession(a);
    // a project record on b so the repo is known there
    process.env.SIEVE_HOME = b.home;
    const gsb = new GlobalStore();
    gsb.touchProject(resolveProject(b.repo));
    gsb.close();
    const folder = tmp("sv-folder-");
    const env = { SIEVE_SYNC_PASSPHRASE: "long enough passphrase" };
    expect((await sieve(a.home, a.repo, ["sync", "init", folder], env)).out).toContain("Sync folder ready");
    const push = await sieve(a.home, a.repo, ["sync", "push"], env);
    expect(push.out).toContain("Pushed 1 fact(s)");
    await sieve(b.home, b.repo, ["sync", "init", folder], env);
    const pull = await sieve(b.home, b.repo, ["sync", "pull"], env);
    expect(pull.out).toContain("Pulled 1 new fact(s)");
    expect(pull.out).toContain("imported 1 session(s)");
    expect((await sieve(b.home, b.repo, ["memory", "list"])).out).toContain("api database: postgres");
    expect(
      (await sieve(b.home, b.repo, ["sync", "pull"], { SIEVE_SYNC_PASSPHRASE: "not the right one" })).err,
    ).toContain("wrong passphrase");
    expect((await sieve(b.home, b.repo, ["sync", "pull"])).code).toBe(2);
  });
});
