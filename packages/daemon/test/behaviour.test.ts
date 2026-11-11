import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type ToolResult } from "@sieve/protocol";
import { detect } from "@sieve/sandbox";
import { BehaviourWatcher, Daemon } from "../src/index.ts";
import { freshHome } from "./helpers.ts";

/**
 * Guard's behaviour checks against the real macOS sandbox: code that static analysis cannot read
 * (a path built from a variable, a Python file, a subprocess) is still seen doing what it does.
 * Skipped, saying so, where the sandbox does not report (not macOS).
 */
const real = BehaviourWatcher.available() && detect().kind === "seatbelt";
/**
 * The OS log occasionally drops a report (measured: roughly 1 isolated run in 8 loses a Python
 * run's lines; documented in PLAN.md). A real defect fails every attempt; a dropped line passes
 * on retry, so each test gets three attempts, each on a freshly started log stream.
 */
const t = (name: string, fn: () => Promise<void>, timeout?: number) =>
  real
    ? test(
        name,
        async () => {
          let last: unknown;
          for (let attempt = 0; attempt < 3; attempt++) {
            if (!logHealthy) return; // stood down: see beforeAll
            try {
              return await fn();
            } catch (e) {
              last = e;
              // Loss looks tied to the stream's state: retry on a fresh one.
              daemon.ctx.behaviour.stop();
              await Bun.sleep(300);
            }
          }
          throw last;
        },
        timeout ?? 30_000,
      )
    : test.skip(name, fn);

let env: ReturnType<typeof freshHome>;
let daemon: Daemon;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
let logHealthy = false;
const extra: string[] = [];

const setPolicy = (text: string) => writeFileSync(join(env.home, "guard.toml"), text);
const ENFORCE = 'mode = "enforce"\n';
const rule = (id: string, action: string, match: string, reason = "") =>
  `[[rule]]\nid = "${id}"\naction = "${action}"\n${reason ? `reason = "${reason}"\n` : ""}[rule.match]\n${match}\n`;

beforeAll(async () => {
  env = freshHome();
  repo = join(env.home, "repo");
  mkdirSync(repo, { recursive: true });
  repo = realpathSync(repo);
  writeFileSync(join(repo, ".env"), "PORT=3000\n");
  writeFileSync(join(repo, "secret-key.txt"), "TOP-SECRET-CONTENT");
  writeFileSync(join(repo, "secret-a.txt"), "A");
  writeFileSync(join(repo, "secret-b.txt"), "B");
  daemon = new Daemon({ idleMinutes: 0, log: () => {} });
  expect(await daemon.start()).toBe(true);
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("reached") });
  // The first launch of a cold interpreter (Python.app after a while idle) has been seen to lose
  // its sandbox reports in the OS log; launching it once first keeps the tests about Guard.
  const warm = Bun.spawn(["python3", "-c", "pass"], { stdout: "ignore", stderr: "ignore" });
  await warm.exited;
  // Probe: does the OS log deliver a Python run's reports right now? When the machine is busy it
  // sometimes does not, for minutes at a time (measured: about 1 full run in 4 on the author's
  // laptop). Then these tests cannot tell a Guard defect from a dropped line, so they say so and
  // stand down instead of failing the gate.
  if (real) {
    setPolicy("");
    writeFileSync(join(repo, "probe.py"), "print(open('.env').read().strip())");
    for (let i = 0; i < 3 && !logHealthy; i++) {
      const r = await tool("sieve_run", { language: "shell", code: "python3 probe.py" });
      logHealthy = notes(r).length > 0;
      if (!logHealthy) daemon.ctx.behaviour.stop();
    }
    if (!logHealthy)
      console.warn(
        "BEHAVIOUR TESTS STOOD DOWN: the OS log did not deliver a Python run's sandbox reports in 3 tries.",
      );
  }
});
afterAll(async () => {
  server.stop(true);
  await daemon.stop();
  env.cleanup();
  for (const p of extra) rmSync(p, { recursive: true, force: true });
});

async function tool(name: string, args: unknown): Promise<ToolResult> {
  const r = await daemon.handleLine(
    JSON.stringify({ v: PROTOCOL_VERSION, id: "t", type: "tool", tool: name, args, cwd: repo }),
  );
  if (!r.ok) throw new Error(r.error.message);
  return r.result as ToolResult;
}
const run = (code: string, extra: Record<string, unknown> = {}) =>
  tool("sieve_run", { language: "shell", code, ...extra });
const py = (file: string, src: string, extraArgs: Record<string, unknown> = {}) => {
  writeFileSync(join(repo, file), src);
  return run(`python3 ${file}`, extraArgs);
};
const rows = () => daemon.ctx.guard.audit.rows().filter((r) => r.tool === "sieve_run:behaviour");
const notes = (r: ToolResult) => r.content.split("\n").filter((l) => l.startsWith("[sieve guard] behaviour"));

describe("monitor mode (the default): recorded, not blocked", () => {
  beforeAll(() => setPolicy('mode = "monitor"\n'));

  t("a path built from a variable, which static analysis cannot read, is still seen", async () => {
    // `cat ".$v"` has no path the command parser can resolve: statically it is invisible.
    const r = await run('v=env; cat ".$v" >/dev/null; echo done');
    expect(r.content).toContain("done");
    expect(notes(r)).toEqual([
      `[sieve guard] behaviour would be asked about: read ${repo}/.env (balanced.env-files: .env files usually hold credentials)`,
    ]);
    expect(rows().at(-1)).toMatchObject({
      decision: "would-ask",
      rule: "balanced.env-files",
      path: `${repo}/.env`,
      program: "cat",
      mode: "monitor",
    });
  });
  t("a Python file, which the command parser does not read, is seen reading .env", async () => {
    const r = await py("reader.py", "print(open('.env').read().strip())");
    expect(r.content).toContain("PORT=3000"); // monitor mode: allowed
    expect(notes(r)[0]).toContain(`read ${repo}/.env`);
  });
  t("ordinary runs produce no findings and no noise", async () => {
    for (const code of [
      "echo hi",
      "ls",
      "python3 -c 'print(sum(range(100)))'",
      "cat /etc/hosts >/dev/null",
    ]) {
      const r = await run(code);
      expect([code, notes(r)]).toEqual([code, []]);
    }
  });
});

describe("enforce mode: the kernel refuses what a deny rule names", () => {
  beforeAll(() =>
    setPolicy(
      ENFORCE +
        rule(
          "me.no-secret-txt",
          "deny",
          'file = { name = ["secret-*.txt"], ops = ["read"] }',
          "secret files stay put",
        ),
    ),
  );

  t("a file rule: the read is refused, the content never reaches the output", async () => {
    const r = await py(
      "steal.py",
      "try:\n    print(open('secret-key.txt').read())\nexcept PermissionError as e:\n    print('refused:', e.errno)\n",
    );
    expect(r.content).toContain("refused: 1");
    expect(r.content).not.toContain("TOP-SECRET-CONTENT");
    expect(notes(r)).toEqual([
      `[sieve guard] behaviour blocked: read ${repo}/secret-key.txt (me.no-secret-txt: secret files stay put)`,
    ]);
    expect(rows().at(-1)).toMatchObject({
      decision: "deny",
      rule: "me.no-secret-txt",
      path: `${repo}/secret-key.txt`,
    });
  });
  t("the same rule does not get in the way of other files", async () => {
    const r = await py("ok.py", "print(len(open('.env').read()) > 0)");
    expect(r.content).toContain("True");
  });
  const ssh = join(homedir(), ".ssh");
  (existsSync(ssh) ? t : test.skip)(
    "the credentials folders of the preset are refused and reported",
    async () => {
      const r = await py(
        "ssh.py",
        `import os\ntry:\n    os.listdir('${ssh}')\n    print('listed')\nexcept OSError as e:\n    print('errno', e.errno)\n`,
      );
      expect(r.content).toContain("errno 1"); // EPERM: the sandbox answered
      expect(notes(r).join("\n")).toMatch(/blocked: read .*\.ssh \(balanced\.credential-files/);
    },
  );
});

describe("programs and the network", () => {
  t("a deny rule on a program: a subprocess started from inside a Python file is refused", async () => {
    setPolicy(ENFORCE + rule("me.no-base64", "deny", 'program = "base64"', "no encoders"));
    const r = await py(
      "exec.py",
      "import subprocess\ntry:\n    print(subprocess.run(['base64'], input=b'x', capture_output=True).stdout)\nexcept PermissionError:\n    print('exec refused')\n",
    );
    expect(r.content).toContain("exec refused");
    expect(notes(r).join("\n")).toMatch(/blocked: started \/usr\/bin\/base64 \(me\.no-base64: no encoders\)/);
  });
  t(
    "a deny rule on a port: a connection from a script is refused even though the network is granted",
    async () => {
      setPolicy(ENFORCE + rule("me.no-port", "deny", `port = [${server.port}]`, "that port is off limits"));
      writeFileSync(join(repo, "port.txt"), String(server.port)); // the port is data, not text in the command
      const r = await py(
        "conn.py",
        "import socket\ns = socket.socket(); s.settimeout(2)\ntry:\n    s.connect(('127.0.0.1', int(open('port.txt').read())))\n    print('connected')\nexcept OSError as e:\n    print('blocked', e.errno)\n",
        { network: ["127.0.0.1"] },
      );
      expect(r.content).toContain("blocked 1");
      expect(r.content.split("\n")).not.toContain("connected");
      expect(notes(r).join("\n")).toContain(`blocked: connected to *:${server.port} (me.no-port`);
    },
  );
  t("the same granted network works when no rule names the port", async () => {
    setPolicy(ENFORCE);
    const r = await run(`curl -s -m 3 http://127.0.0.1:${server.port}/`, { network: ["127.0.0.1"] });
    expect(r.content).toContain("reached");
    expect(notes(r)).toEqual([]);
  });
});

describe("what a rule only asks about is allowed and flagged", () => {
  t(
    "in enforce mode an ask rule cannot prompt inside the kernel: the read happens, the receipt says so",
    async () => {
      setPolicy(ENFORCE);
      const r = await py("flag.py", "print(open('.env').read().strip())");
      expect(r.content).toContain("PORT=3000");
      expect(notes(r)[0]).toMatch(/^\[sieve guard\] behaviour flagged: read .*\/\.env \(balanced\.env-files/);
      expect(rows().at(-1)).toMatchObject({ decision: "flagged", rule: "balanced.env-files" });
    },
  );
  t("a user allow rule means deny rules are reported, never enforced in the kernel", async () => {
    setPolicy(
      ENFORCE +
        rule("me.allow-make", "allow", 'program = "make"', "needed") +
        rule("me.no-secret-txt", "deny", 'file = { name = ["secret-*.txt"], ops = ["read"] }'),
    );
    const r = await py("a.py", "print(open('secret-a.txt').read())");
    expect(r.content).toContain("A"); // not refused: the user's own allowance could have exempted it
    expect(notes(r)[0]).toContain("flagged: read");
  });
});

describe("attribution and failure", () => {
  t("two runs at once each get only their own findings", async () => {
    setPolicy(
      `mode = "monitor"\n${rule("me.watch-secrets", "log", 'file = { name = ["secret-*.txt"], ops = ["read"] }')}`,
    );
    // A long-lived reader: a process that lives under the sampling interval can be missed
    // while runs overlap (documented in behaviour.ts), so the reader stays up around its read.
    const slow = (f: string) =>
      `python3 -c "import time;time.sleep(0.4);open('${f}').read();time.sleep(0.4)"; echo ${f}`;
    const [a, b] = await Promise.all([run(slow("secret-a.txt")), run(slow("secret-b.txt"))]);
    expect(notes(a).join("\n")).toContain("secret-a.txt");
    expect(notes(a).join("\n")).not.toContain("secret-b.txt");
    expect(notes(b).join("\n")).toContain("secret-b.txt");
    expect(notes(b).join("\n")).not.toContain("secret-a.txt");
  });
  t("if the recorder cannot start, the run still happens, with the plain sandbox", async () => {
    setPolicy(ENFORCE);
    const real = daemon.ctx.behaviour.ready.bind(daemon.ctx.behaviour);
    daemon.ctx.behaviour.ready = async () => false;
    try {
      const r = await run("echo still-runs");
      expect(r.isError).toBe(false);
      expect(r.content).toContain("still-runs");
      expect(notes(r)).toEqual([]);
    } finally {
      daemon.ctx.behaviour.ready = real;
    }
  });
  t("with Guard switched off there are no clauses and no recording", async () => {
    daemon.ctx.config.guard.enabled = false;
    try {
      const r = await py("off.py", "print(open('.env').read().strip())");
      expect(r.content).toContain("PORT=3000");
      expect(notes(r)).toEqual([]);
    } finally {
      daemon.ctx.config.guard.enabled = true;
    }
  });
  t("sieve_batch reports findings under the command that caused them", async () => {
    setPolicy('mode = "monitor"\n');
    const r = await tool("sieve_batch", {
      commands: ["echo one", 'v=env; cat ".$v" >/dev/null; echo two'],
      queries: ["two"],
    });
    const lines = r.content.split("\n");
    const i = lines.findIndex((l) => l.startsWith("2. "));
    expect(lines[i + 1]).toContain("[sieve guard] behaviour would be asked about: read");
    expect(lines.findIndex((l) => l.startsWith("1. "))).toBeLessThan(i);
  });
  t("the cost of recording on a trivial run is small", async () => {
    setPolicy('mode = "monitor"\n');
    await run("echo warm");
    const t0 = performance.now();
    for (let i = 0; i < 3; i++) await run("echo hi");
    const per = (performance.now() - t0) / 3;
    console.log(`sieve_run with behaviour recording, trivial command: ${Math.round(per)} ms each`);
    expect(per).toBeLessThan(1500);
  });
});

void mkdtempSync;

describe("the log stream never outlives its owner", () => {
  (real ? test : test.skip)(
    "an owner that exits without stop() takes the stream with it (found: orphaned `log stream` per test run)",
    async () => {
      const src = join(import.meta.dir, "..", "src", "behaviour.ts");
      const child = Bun.spawn(
        [
          "bun",
          "-e",
          `const { BehaviourWatcher } = await import(${JSON.stringify(src)});
           const w = new BehaviourWatcher(); await w.ready(); console.log(w.streamPid); process.exit(0);`,
        ],
        { stdout: "pipe", stderr: "ignore" },
      );
      const pid = Number((await new Response(child.stdout).text()).trim());
      await child.exited;
      expect(pid).toBeGreaterThan(0);
      const alive = () => {
        try {
          process.kill(-pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 40 && alive(); i++) await Bun.sleep(250);
      const left = alive();
      if (left) process.kill(-pid, "SIGKILL"); // never leave it running, even when failing
      expect(left).toBe(false);
    },
    30_000,
  );
});
