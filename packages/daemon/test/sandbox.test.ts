import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type ToolResult } from "@sieve/protocol";
import { detect } from "@sieve/sandbox";
import { Daemon, execute } from "../src/index.ts";
import { freshHome } from "./helpers.ts";

/**
 * The sandbox is tested by trying to get out of it, on the real OS backend. Where the machine
 * has none (no bwrap, or an unsupported platform) these tests say so and skip: the honest
 * "isolation: none" receipt is still checked.
 */
const real = detect().kind !== "none";
const t = real ? test : test.skip;

let env: ReturnType<typeof freshHome>;
let daemon: Daemon;
let repo: string;
const probes: string[] = [];

beforeAll(async () => {
  env = freshHome();
  repo = join(env.home, "repo");
  mkdirSync(repo, { recursive: true });
  repo = realpathSync(repo);
  daemon = new Daemon({ idleMinutes: 0, log: () => {} });
  expect(await daemon.start()).toBe(true);
});
afterAll(async () => {
  await daemon.stop();
  env.cleanup();
  for (const p of probes) rmSync(p, { recursive: true, force: true });
});

async function tool(name: string, args: unknown): Promise<ToolResult> {
  const r = await daemon.handleLine(
    JSON.stringify({ v: PROTOCOL_VERSION, id: "t", type: "tool", tool: name, args, cwd: repo }),
  );
  if (!r.ok) throw new Error(r.error.message);
  return r.result as ToolResult;
}
const sh = (code: string, extra: Record<string, unknown> = {}) =>
  tool("sieve_run", { language: "shell", code, ...extra });
type SB = { project: string[]; mode: "auto" | "off" | "require"; denyRead?: string[] };
const run = async (code: string, sb: SB = { project: [repo], mode: "auto" }, extra = {}) =>
  execute({ language: "shell", code, ...extra }, repo, undefined, sb).done;

describe("what the receipt says", () => {
  test("states the isolation actually in force, including none", async () => {
    const r = await sh("echo hi");
    expect(r.content).toContain(`isolation: ${detect().kind}`);
    if (real) {
      expect(r.content).toContain("network: off");
      expect(r.content).toContain("writes: project + scratch only");
      expect(r.content).toContain("memory and process counts are not limited");
    }
  });
  test("mode off is stated as such, not as a sandbox", async () => {
    const o = await run("echo hi", { project: [repo], mode: "off" });
    expect(o.isolation).toBe(
      "none (sandbox turned off in config; code runs as you, with full file and network access)",
    );
  });
});

describe("writes", () => {
  t(
    "a file outside the project and scratch folder cannot be created, and nothing is left behind",
    async () => {
      const target = join(homedir(), `.sieve-sandbox-probe-${process.pid}`);
      probes.push(target);
      const o = await run(`echo escaped > "${target}"; echo "rc=$?"`);
      expect(o.output).toMatch(/rc=[1-9]/);
      expect(existsSync(target)).toBe(false);
    },
  );
  t("the project and TMPDIR are writable", async () => {
    const o = await run(`echo a > "${repo}/made.txt" && echo b > "$TMPDIR/scratch.txt" && echo ok`);
    expect(o.output.trim()).toBe("ok");
    expect(readFileSync(join(repo, "made.txt"), "utf8")).toBe("a\n");
  });
  t("a granted folder is writable; a refused grant stops the run before anything starts", async () => {
    const extra = mkdtempSync("/tmp/sv-grant-");
    probes.push(extra);
    const ok = await sh(`echo granted > "${extra}/f" && echo done`, { writable: [extra] });
    expect(ok.content).toContain("done");
    expect(readFileSync(join(extra, "f"), "utf8")).toBe("granted\n");
    const denied = await sh("echo no", { writable: [homedir()] });
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("not run: refusing to make your whole home folder writable");
  });
});

describe("network", () => {
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("reached") });
  });
  afterAll(() => server.stop(true));
  const curl = () => `curl -s -m 3 http://127.0.0.1:${server.port}/ || echo BLOCKED`;
  t("is off by default (even to localhost)", async () => {
    const o = await run(curl());
    expect(o.output).toContain("BLOCKED");
    expect(o.output).not.toContain("reached");
  });
  t("a call that asks for network gets it, and the receipt says the host list is not filtered", async () => {
    const r = await sh(curl(), { network: ["127.0.0.1"] });
    expect(r.content).toContain("reached");
    expect(r.content).toContain("network: on (all hosts; hosts 127.0.0.1 requested, not filtered)");
  });
});

describe("environment", () => {
  beforeAll(() => {
    process.env.SIEVE_TEST_API_KEY = "pass-through-value";
  });
  afterAll(() => {
    delete process.env.SIEVE_TEST_API_KEY;
  });
  t("secrets in the daemon's environment are not visible to the code unless asked for", async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not a template
    const o = await run('echo "[${SIEVE_TEST_API_KEY}] [${PATH:+path-present}]"');
    expect(o.output.trim()).toBe("[] [path-present]");
    const g = await run(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not a template
      'echo "[${SIEVE_TEST_API_KEY}]"',
      { project: [repo], mode: "auto" },
      { env: ["SIEVE_TEST_API_KEY"] },
    );
    expect(g.output.trim()).toBe("[pass-through-value]");
  });
  t("TMPDIR points into the per-run scratch folder, which is deleted afterwards", async () => {
    const o = await run('echo "$TMPDIR"');
    const dir = o.output.trim();
    expect(dir).toMatch(/sieve-run-/);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("reads", () => {
  t("a denied folder cannot be read; the rest of the machine still can", async () => {
    const secretDir = join(repo, "vault");
    mkdirSync(secretDir);
    writeFileSync(join(secretDir, "key.txt"), "top secret");
    const sb = { project: [repo], mode: "auto" as const, denyRead: [secretDir] };
    const o = await run(
      `cat "${secretDir}/key.txt" 2>&1; echo rc=$?; cat /etc/hosts >/dev/null && echo etc-ok`,
      sb,
    );
    expect(o.output).not.toContain("top secret");
    expect(o.output).toMatch(/rc=[1-9]/);
    expect(o.output).toContain("etc-ok");
  });
  t("a deny that would cover the project itself is dropped, so the run still works", async () => {
    const o = await run("pwd; ls . >/dev/null && echo listed", {
      project: [repo],
      mode: "auto",
      denyRead: [env.home],
    });
    expect(o.output).toContain("listed");
    expect(o.output).not.toContain("Operation not permitted");
  });
  t("the daemon's own state folder is denied", async () => {
    const elsewhere = mkdtempSync("/tmp/sv-proj-");
    probes.push(elsewhere);
    const o = await execute(
      { language: "shell", code: `ls "${env.home}/run" 2>&1; echo rc=$?` },
      elsewhere,
      undefined,
      {
        project: [realpathSync(elsewhere)],
        mode: "auto",
        denyRead: [env.home],
      },
    ).done;
    expect(o.output).toMatch(/rc=[1-9]/);
  });
});

describe("languages and limits still work inside the sandbox", () => {
  t("JavaScript runs on Sieve's own Bun; Python runs when present", async () => {
    const js = await tool("sieve_run", { language: "js", code: "console.log(6 * 7)" });
    expect(js.content).toContain("42");
    if (Bun.which("python3")) {
      const py = await tool("sieve_run", { language: "python", code: "print(sum(range(10)))" });
      expect(py.content).toContain("45");
    }
  });
  t("the timeout still kills the whole process tree", async () => {
    const o = await execute(
      { language: "shell", code: "sleep 30 & sleep 30; wait", timeoutMs: 600 },
      repo,
      undefined,
      {
        project: [repo],
        mode: "auto",
      },
    ).done;
    expect(o.timedOut).toBe(true);
    expect(o.durationMs).toBeLessThan(5000);
  });
  t("sieve_batch runs each command in the sandbox", async () => {
    const r = await tool("sieve_batch", {
      commands: ['echo x > "$HOME/.sieve-batch-probe-$$" 2>&1 || echo DENIED'],
      queries: ["DENIED"],
    });
    expect(r.content).toContain(`isolation: ${detect().kind}`);
    expect(r.content).toContain("DENIED");
  });
});

describe("secrets in run output", () => {
  test("are masked in the result, in the archive, and the header says how many", async () => {
    const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    const r = await sh(`echo "token is ${token}"; echo "API_KEY=abcdef$((100000+23456))"`);
    expect(r.content).not.toContain(token);
    expect(r.content).not.toContain("abcdef123456");
    expect(r.content).toContain("token is <secret:github_token#1>");
    expect(r.content).toContain("API_KEY=<secret:secret_value#1>");
    expect(r.content).toContain("2 secrets masked (github_token ×1, secret_value ×1)");
    const id = /archived (s_[a-z2-7]+)/.exec(r.content)![1]!;
    const got = await tool("sieve_get", { id });
    expect(got.content).toContain("<secret:github_token#1>");
    expect(got.content).not.toContain(token);
  });
});
