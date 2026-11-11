import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SIEVE_VERSION } from "@sieve/protocol";
import { EVENTS, PLUGIN_NAME, TOOL_EVENTS } from "../src/index.ts";

/**
 * The Claude Code plugin (plugins/sieve) and its marketplace (.claude-plugin/marketplace.json).
 * Replayed through the real hook script, shim and daemon; never run in a live Claude Code session.
 */
const ROOT = resolve(import.meta.dir, "../../../..");
const PLUGIN = join(ROOT, "plugins", "sieve");
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("plugin manifests", () => {
  test("hooks.json registers exactly the adapter's events and matchers, with a short timeout", () => {
    const hooks = json(join(PLUGIN, "hooks", "hooks.json")).hooks as Record<
      string,
      Array<{ matcher?: string; hooks: Array<{ command: string; timeout: number }> }>
    >;
    expect(Object.keys(hooks).sort()).toEqual([...EVENTS].sort());
    for (const [event, entries] of Object.entries(hooks)) {
      expect(entries).toHaveLength(1);
      expect(entries[0]!.matcher).toBe(TOOL_EVENTS.has(event) ? "*" : undefined);
      expect(entries[0]!.hooks[0]!.command).toBe(`"\${CLAUDE_PLUGIN_ROOT}/hooks/run.sh" ${event}`);
      expect(entries[0]!.hooks[0]!.timeout).toBe(5); // the plugin default is 600 s
    }
  });

  test("names and versions agree: marketplace entry, plugin.json, the binary, the tool-name mapping", () => {
    const plugin = json(join(PLUGIN, ".claude-plugin", "plugin.json"));
    const market = json(join(ROOT, ".claude-plugin", "marketplace.json"));
    expect(plugin.name).toBe(PLUGIN_NAME);
    expect(market.plugins.map((p: { name: string }) => p.name)).toEqual([plugin.name]);
    expect(market.plugins[0].source).toBe("./plugins/sieve");
    expect(plugin.version).toBe(SIEVE_VERSION);
    const mcp = json(join(PLUGIN, ".mcp.json")).mcpServers;
    expect(Object.keys(mcp)).toEqual(["sieve"]); // with PLUGIN_NAME, gives mcp__plugin_sieve_sieve__*
    // Claude Code expands this itself; the literal string is what the file must contain.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a Claude Code variable, not a JS template
    expect(mcp.sieve.command).toBe("${CLAUDE_PLUGIN_ROOT}/bin/sieve");
  });

  test("scripts are executable and nothing triggers a dependency install", () => {
    for (const f of ["hooks/run.sh", "bin/sieve", "bin/sieve-install"])
      expect(statSync(join(PLUGIN, f)).mode & 0o111).not.toBe(0);
    expect(existsSync(join(PLUGIN, "package.json"))).toBe(false);
  });
});

const DIST = join(ROOT, "dist");
const built = existsSync(join(DIST, "sieve")) && existsSync(join(DIST, "sieve-hook"));
const homes: string[] = [];
afterAll(async () => {
  for (const h of homes) {
    await sh([join(h, "bin", "sieve"), "daemon", "stop"], { SIEVE_HOME: h }).catch(() => {});
    // `stop` returns before the daemon exits; never delete a home under a running daemon.
    for (let i = 0; i < 50 && existsSync(join(h, "run", "sieved.lock")); i++) await Bun.sleep(100);
    rmSync(h, { recursive: true, force: true });
  }
});

async function sh(cmd: string[], env: Record<string, string>, stdin?: string) {
  const p = Bun.spawn(cmd, {
    env: { ...process.env, ...env },
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

function home() {
  const h = mkdtempSync("/tmp/sv-plg-");
  homes.push(h);
  const cfg = join(h, "claude");
  mkdirSync(cfg);
  return {
    h,
    env: { SIEVE_HOME: h, CLAUDE_CONFIG_DIR: cfg, SIEVE_HOOK_TIMEOUT_MS: "3000", SIEVE_BIN: "" },
    cfg,
  };
}

const post = (cwd: string) =>
  JSON.stringify({
    session_id: "plg",
    cwd,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: {
      stdout: Array.from({ length: 1500 }, (_, i) => `PASS case ${i} lorem ipsum dolor sit amet`).join("\n"),
      stderr: "",
      interrupted: false,
    },
  });

async function hookUntilReply(env: Record<string, string>, input: string) {
  for (let i = 0; i < 20; i++) {
    const r = await sh([join(PLUGIN, "hooks", "run.sh"), "PostToolUse"], env, input);
    if (r.out) return r;
    await Bun.sleep(300); // the first call starts the daemon and passes through
  }
  return { code: 0, out: "", err: "" };
}

describe.if(built)("plugin hook route (replayed through run.sh, the Go shim and a real daemon)", () => {
  test("installed from a local build: a large output comes back as a receipt", async () => {
    const { h, env } = home();
    const inst = await sh([join(PLUGIN, "bin", "sieve-install"), "--from", DIST], env);
    expect(inst.code).toBe(0);
    expect(inst.out).toContain(`sieve ${SIEVE_VERSION}`);
    const r = await hookUntilReply(env, post(h));
    expect(r.code).toBe(0);
    expect(r.out).toContain("sieve s_");
    // the plugin's `sieve` command runs the installed binary
    expect((await sh([join(PLUGIN, "bin", "sieve"), "version"], env)).out).toContain(SIEVE_VERSION);
  }, 60_000);

  test("with `sieve setup` hooks also in settings.json, the plugin route stays silent", async () => {
    const { h, env, cfg } = home();
    expect((await sh([join(PLUGIN, "bin", "sieve-install"), "--from", DIST], env)).code).toBe(0);
    expect((await hookUntilReply(env, post(h))).out).toContain("sieve s_"); // daemon up, plugin acts
    writeFileSync(
      join(cfg, "settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "*",
              hooks: [{ type: "command", command: '"/x/sieve-hook" claude-code PostToolUse' }],
            },
          ],
        },
      }),
    );
    const r = await sh([join(PLUGIN, "hooks", "run.sh"), "PostToolUse"], env, post(h));
    expect(r).toEqual({ code: 0, out: "", err: "" });
  }, 60_000);

  test("--link installs symlinks to a development build, and nothing is left staged", async () => {
    const { h, env } = home();
    const r = await sh([join(PLUGIN, "bin", "sieve-install"), "--from", DIST, "--link"], env);
    expect(r.code).toBe(0);
    const { lstatSync, readdirSync, readlinkSync } = await import("node:fs");
    for (const f of ["sieve", "sieve-hook"]) {
      expect(lstatSync(join(h, "bin", f)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(h, "bin", f))).toBe(join(DIST, f));
    }
    expect(readdirSync(join(h, "bin")).sort()).toEqual(["sieve", "sieve-hook"]);
  }, 60_000);

  test("binary not installed: passes through, exits 0, logs a miss (never blocks the agent)", async () => {
    const { h, env } = home();
    const r = await sh([join(PLUGIN, "hooks", "run.sh"), "PostToolUse"], env, post(h));
    expect(r).toEqual({ code: 0, out: "", err: "" });
    expect(readFileSync(join(h, "run", "misses.log"), "utf8")).toContain(
      "claude-code\tPostToolUse\tplugin-binary-missing",
    );
    const cli = await sh([join(PLUGIN, "bin", "sieve"), "status"], env);
    expect(cli.code).toBe(127);
    expect(cli.err).toContain("/sieve:install");
  });
});
