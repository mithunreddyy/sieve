import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO, SHIM, SIEVE } from "./helpers.ts";

/**
 * "Zero network calls in default mode" (v1.0 definition of done), checked two ways:
 *  1. every place in the source that can open a network connection is on a short list of commands
 *     the user starts, so a new call site has to be added here, on purpose;
 *  2. on macOS, the whole hook flow (shim, daemon start, fold, receipt) runs under a Seatbelt profile
 *     that refuses all IP networking, after proving the profile really does refuse a connection.
 */

const CALLERS = [
  /\bfetch\(/,
  /\?\? fetch\)/, // an injectable fetch with the global as the default
  /Bun\.connect\(/,
  /\bnet\.(connect|createConnection)\(/,
  /\bhttps?\.(request|get)\(/,
  /new WebSocket\(/,
  /\bdns\.(lookup|resolve)/,
  /Bun\.(serve|listen)\(/, // listening is not calling out, but it is network surface: listed too
];

/** Files allowed to contain them, and what makes each one start only on a user action. */
const ALLOWED: Record<string, string> = {
  "packages/proxy/src/server.ts": "sieve proxy: forwards to the upstream you configured",
  "packages/cli/src/upgrade.ts": "sieve upgrade --from https://…",
  "packages/daemon/src/extraction.ts": "opt-in extraction to a model server on this machine",
  "packages/dashboard/src/server.ts": "sieve dash: listens on 127.0.0.1",
  "packages/dashboard/src/page.ts": "browser script in the dashboard page: fetches its own 127.0.0.1 origin",
  "packages/proxy/src/index.ts": "re-export only",
};

function* sources(dir: string): Generator<string> {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "test" || n === "dist" || n.startsWith(".")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) yield* sources(p);
    else if (/\.(ts|js)$/.test(n) && !n.endsWith(".d.ts")) yield p;
  }
}

describe("network call sites", () => {
  test("only the listed commands can open a connection", () => {
    const found: string[] = [];
    for (const f of sources(join(REPO, "packages"))) {
      const text = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      if (CALLERS.some((re) => re.test(text))) found.push(relative(REPO, f));
    }
    const unexpected = found.filter((f) => !(f in ALLOWED));
    expect(unexpected).toEqual([]);
    // and the list does not rot: every entry still has a call site
    expect(
      Object.keys(ALLOWED).filter((f) => !found.includes(f) && f !== "packages/proxy/src/index.ts"),
    ).toEqual([]);
  });
});

const darwin = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const built = existsSync(SHIM) && existsSync(SIEVE);
const t = darwin && built ? test : test.skip;
const NO_NET = "(version 1)(allow default)(deny network* (remote ip))(deny network* (local ip))";

async function jailed(cmd: string[], env: Record<string, string>, stdin?: string) {
  const p = Bun.spawn(["/usr/bin/sandbox-exec", "-p", NO_NET, ...cmd], {
    env: { ...process.env, ...env },
    stdin: stdin ? Buffer.from(stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

describe("with the network refused", () => {
  t("the profile really does stop a TCP connection (so the next test means something)", async () => {
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("reachable") });
    try {
      const ok = await fetch(`http://127.0.0.1:${s.port}`).then((r) => r.text());
      expect(ok).toBe("reachable");
      const r = await jailed(
        [
          "bun",
          "-e",
          `try { await fetch("http://127.0.0.1:${s.port}"); console.log("CONNECTED") } catch { console.log("REFUSED") }`,
        ],
        {},
      );
      expect(r.out.trim()).toBe("REFUSED");
    } finally {
      s.stop(true);
    }
  });

  t(
    "hooks, the daemon, folding, a tool call and status all work",
    async () => {
      const home = mkdtempSync("/tmp/sv-off-");
      try {
        const env = { SIEVE_HOME: home, SIEVE_BIN: SIEVE, SIEVE_HOOK_TIMEOUT_MS: "3000" };
        const big = Array.from({ length: 1500 }, (_, i) => `PASS case ${i} lorem ipsum dolor sit amet`).join(
          "\n",
        );
        const input = JSON.stringify({
          session_id: "off",
          cwd: home,
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "npm test" },
          tool_response: { stdout: big, stderr: "", interrupted: false },
        });
        let out = "";
        for (let i = 0; i < 20 && !out; i++) {
          out = (await jailed([SHIM, "claude-code", "PostToolUse"], env, input)).out;
          if (!out) await Bun.sleep(300); // the first call starts the daemon and passes through
        }
        expect(out).toContain("sieve s_"); // a receipt came back with no network
        const st = await jailed([SIEVE, "status"], env);
        expect(st.out).toContain("daemon");
        expect(st.out).toContain("v");
        const search = await jailed([SIEVE, "search", "lorem"], env);
        expect(search.code).toBe(0);
      } finally {
        await jailed([SIEVE, "daemon", "stop"], { SIEVE_HOME: home }).catch(() => {});
        // `stop` returns before the daemon has exited; deleting its home under it used to leak a
        // daemon spinning at 100% CPU. Wait for the lock to go first.
        const lock = join(home, "run", "sieved.lock");
        for (let i = 0; i < 50 && existsSync(lock); i++) await Bun.sleep(100);
        rmSync(home, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
