import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySetup } from "@sieve/adapter-kit";
import {
  planSetup,
  readRequest,
  readWasWhole,
  render,
  setupSpec,
  toEvent,
  verifySetup,
} from "../src/index.ts";

function sandbox(existing?: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "sieve-oc-"));
  const configDir = join(dir, "opencode");
  mkdirSync(configDir);
  mkdirSync(join(dir, "bin"));
  const sievePath = join(dir, "bin", "sieve");
  const shimPath = join(dir, "bin", "sieve-hook");
  for (const f of [sievePath, shimPath]) {
    writeFileSync(f, "#!/bin/sh\n");
    chmodSync(f, 0o755);
  }
  const config = join(configDir, "opencode.json");
  if (existing) writeFileSync(config, JSON.stringify(existing, null, 2));
  return {
    configDir,
    config,
    plugin: join(configDir, "plugins", "sieve.ts"),
    opts: { configDir, sievePath, shimPath, backupRoot: join(dir, "b") },
  };
}

describe("opencode setup", () => {
  test("installs the plugin with this machine's sieve path and the MCP server; keeps the user's config", () => {
    const s = sandbox({ plugin: ["opencode-antigravity-auth@latest"], provider: { x: 1 } });
    const r = applySetup(setupSpec, s.opts);
    expect(r.verified).toBe(true);
    const text = readFileSync(s.plugin, "utf8");
    expect(text).toContain(`const SIEVE_BIN = ${JSON.stringify(s.opts.sievePath)};`);
    const cfg = JSON.parse(readFileSync(s.config, "utf8"));
    expect(cfg.plugin).toEqual(["opencode-antigravity-auth@latest"]);
    expect(cfg.mcp.sieve).toEqual({ type: "local", command: [s.opts.sievePath, "mcp"], enabled: true });
    expect(planSetup(s.opts)).toEqual([]);
    applySetup(setupSpec, s.opts, true);
    expect(existsSync(s.plugin)).toBe(false);
    expect(JSON.parse(readFileSync(s.config, "utf8"))).toEqual({
      plugin: ["opencode-antigravity-auth@latest"],
      provider: { x: 1 },
    });
  });

  test("never overwrites a sieve.ts it did not write", () => {
    const s = sandbox();
    mkdirSync(join(s.configDir, "plugins"));
    writeFileSync(s.plugin, "export const Mine = async () => ({});\n");
    expect(() => planSetup(s.opts)).toThrow("was not written by Sieve");
  });

  test("verify notices a stale plugin and a disabled server", () => {
    const s = sandbox();
    applySetup(setupSpec, s.opts);
    writeFileSync(
      s.plugin,
      readFileSync(s.plugin, "utf8").replace("const PROTOCOL = 1", "const PROTOCOL = 0"),
    );
    const cfg = JSON.parse(readFileSync(s.config, "utf8"));
    cfg.mcp.sieve.enabled = false;
    writeFileSync(s.config, JSON.stringify(cfg));
    expect(verifySetup(s.opts)).toEqual([
      `plugin ${s.plugin} is out of date`,
      'MCP server "sieve" is disabled',
    ]);
  });
});

describe("opencode events", () => {
  test("reads take filePath or path; a read is whole only from line 1 to the end", () => {
    expect(readRequest({ filePath: "/a" })).toEqual({ path: "/a", full: true });
    expect(readRequest({ path: "/a", offset: 40 })).toEqual({ path: "/a", full: false });
    expect(readWasWhole({ output: "…(End of file - total 3 lines)", args: {} })).toBe(true);
    expect(readWasWhole({ output: "…(End of file - total 3 lines)", args: { offset: 2 } })).toBe(false);
    expect(
      readWasWhole({ output: "(Showing lines 1-2000 of 5000. Use offset=2001 to continue.)", args: {} }),
    ).toBe(false);
  });
  test("bash exit codes mark errors; sieve's own MCP tools are recognised", () => {
    const e = toEvent(
      "tool.execute.after",
      { sessionID: "s", cwd: "/w", tool: "bash", args: {}, output: "x", metadata: { exit: 2 } },
      1,
    );
    expect(e).toMatchObject({ kind: "tool.after", tool: { family: "shell" }, output: { isError: true } });
    expect(toEvent("tool.execute.before", { sessionID: "s", tool: "sieve_sieve_run" }, 1)).toMatchObject({
      tool: { family: "mcp", server: "sieve" },
    });
    expect(toEvent("session.compacted", { sessionID: "s" }, 1)).toBeNull();
  });
  test("render gives the plugin only what to apply", () => {
    const before = toEvent("tool.execute.before", { sessionID: "s", tool: "read", args: {} }, 1)!;
    expect(JSON.parse(render(before, { decision: { action: "deny", reason: "r" } }, {}))).toEqual({
      deny: "r",
    });
    const sc = toEvent("session.created", { sessionID: "s" }, 1)!;
    expect(render(sc, { context: "c" }, {})).toBe(""); // OpenCode has no context slot at session creation
  });
});
