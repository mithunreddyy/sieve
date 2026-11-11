import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySetup, restoreBackup } from "@sieve/adapter-kit";
import { parse } from "smol-toml";
import {
  editedPath,
  outputText,
  patchPaths,
  planSetup,
  render,
  setupSpec,
  toEvent,
  toolRef,
  verifySetup,
} from "../src/index.ts";

const ev = (name: string, extra: Record<string, unknown>) =>
  toEvent(
    name,
    { session_id: "t1", cwd: "/w", hook_event_name: name, model: "m", transcript_path: null, ...extra },
    1,
  );

describe("codex events (from OpenAI's hooks docs)", () => {
  test("PostToolUse: Bash, apply_patch and MCP tools; tool_response in the shapes it can have", () => {
    expect(
      ev("PostToolUse", {
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_response: { stdout: "a", stderr: "e", exit_code: 1 },
      }),
    ).toMatchObject({
      tool: { family: "shell" },
      output: { text: "a\ne", isError: true },
    });
    expect(toolRef("mcp__filesystem__read_file")).toEqual({
      name: "mcp__filesystem__read_file",
      family: "mcp",
      server: "filesystem",
    });
    expect(outputText([{ type: "text", text: "x" }]).text).toBe("x");
    expect(outputText({ weird: 1 }).text).toBe('{"weird":1}');
  });
  test("apply_patch files are read from the patch text", () => {
    const patch =
      "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n+z\n*** End Patch";
    expect(patchPaths(patch)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(editedPath({ command: patch })).toBe("src/a.ts");
  });
  test("lifecycle and the compact source", () => {
    expect(ev("SessionStart", { source: "compact" })).toMatchObject({
      kind: "session.start",
      source: "compact",
    });
    expect(ev("SessionStart", { source: "fork" })).toMatchObject({ source: "startup" });
    expect(ev("PreCompact", { trigger: "manual" })).toMatchObject({ trigger: "manual" });
    expect(ev("SubagentStart", { agent_id: "a", agent_type: "explorer" })).toMatchObject({
      kind: "subagent.start",
      subagentType: "explorer",
    });
    expect(ev("PermissionRequest", {})).toBeNull();
    expect(toEvent("Stop", { cwd: "/w" }, 1)).toBeNull(); // no session id: ignored
  });
  test("render: deny and additionalContext in hookSpecificOutput; nothing for Stop or tool results", () => {
    const pre = ev("PreToolUse", { tool_name: "Bash", tool_input: { command: "x" } })!;
    expect(JSON.parse(render(pre, { decision: { action: "deny", reason: "r" } }, {}))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "r",
      },
    });
    expect(JSON.parse(render(ev("SessionStart", { source: "compact" })!, { context: "c" }, {}))).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "c" },
    });
    expect(render(ev("Stop", {})!, { context: "c" }, {})).toBe("");
    expect(
      render(
        ev("PostToolUse", { tool_name: "Bash", tool_response: "x" })!,
        { replaceOutput: "r", context: "c" },
        {},
      ),
    ).toBe("");
  });
});

function sandbox(toml?: string, hooks?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "sieve-cx-"));
  const configDir = join(dir, ".codex");
  mkdirSync(configDir);
  mkdirSync(join(dir, "bin"));
  const shimPath = join(dir, "bin", "sieve-hook");
  const sievePath = join(dir, "bin", "sieve");
  for (const f of [shimPath, sievePath]) {
    writeFileSync(f, "#!/bin/sh\n");
    chmodSync(f, 0o755);
  }
  if (toml !== undefined) writeFileSync(join(configDir, "config.toml"), toml);
  if (hooks) writeFileSync(join(configDir, "hooks.json"), JSON.stringify(hooks));
  return {
    configDir,
    toml: join(configDir, "config.toml"),
    json: join(configDir, "hooks.json"),
    opts: { configDir, shimPath, sievePath, backupRoot: join(dir, "b") },
  };
}

describe("codex setup", () => {
  const user =
    '# my settings\nmodel = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "npx"\nargs = ["-y", "docs"]\n';
  test("hooks.json plus a managed block in config.toml; the user's TOML text is untouched; remove restores it byte for byte", () => {
    const s = sandbox(user, {
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./audit.sh" }] }] },
    });
    const r = applySetup(setupSpec, s.opts);
    expect(r.verified).toBe(true);
    const text = readFileSync(s.toml, "utf8");
    expect(text.startsWith(user)).toBe(true);
    const parsed = parse(text) as {
      model: string;
      mcp_servers: Record<string, { command: string; args: string[] }>;
    };
    expect(parsed.model).toBe("gpt-5");
    expect(parsed.mcp_servers.docs).toEqual({ command: "npx", args: ["-y", "docs"] });
    expect(parsed.mcp_servers.sieve).toEqual({ command: s.opts.sievePath, args: ["mcp"] });
    const h = JSON.parse(readFileSync(s.json, "utf8")).hooks;
    expect(h.PreToolUse.map((g: { hooks: { command: string }[] }) => g.hooks[0]!.command)).toEqual([
      "./audit.sh",
      `${s.opts.shimPath} codex PreToolUse`,
    ]);
    expect(h.PreToolUse[1].hooks[0].timeout).toBe(3);
    expect(planSetup(s.opts)).toEqual([]);
    applySetup(setupSpec, s.opts, true);
    expect(readFileSync(s.toml, "utf8")).toBe(user);
    expect(restoreBackup(r.backupDir!).length).toBe(2);
  });
  test("a config.toml made by Sieve is deleted on removal; a hand-written [mcp_servers.sieve] is never doubled", () => {
    const s = sandbox();
    applySetup(setupSpec, s.opts);
    applySetup(setupSpec, s.opts, true);
    expect(existsSync(s.toml)).toBe(false);
    const own = sandbox('[mcp_servers.sieve]\ncommand = "mine"\n');
    expect(() => planSetup(own.opts)).toThrow("already defines [mcp_servers.sieve]");
  });
  test("verify reports hooks turned off", () => {
    const s = sandbox();
    applySetup(setupSpec, s.opts);
    writeFileSync(s.toml, `[features]\nhooks = false\n\n${readFileSync(s.toml, "utf8")}`);
    expect(verifySetup(s.opts)).toEqual([`hooks are turned off ([features] hooks = false in ${s.toml})`]);
  });
});
