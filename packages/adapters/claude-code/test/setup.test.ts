import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveId } from "@sieve/core";
import {
  applySetup,
  outputText,
  planSetup,
  render,
  restoreBackup,
  toEvent,
  verifySetup,
} from "../src/index.ts";

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "sieve-cc-"));
  const configDir = join(dir, ".claude");
  mkdirSync(configDir);
  const shimPath = join(dir, "bin", "sieve-hook");
  const sievePath = join(dir, "bin", "sieve");
  mkdirSync(join(dir, "bin"));
  for (const f of [shimPath, sievePath]) {
    writeFileSync(f, "#!/bin/sh\n");
    chmodSync(f, 0o755);
  }
  const userSettings = {
    model: "opus",
    hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "prettier --write" }] }] },
  };
  const settingsText = `${JSON.stringify(userSettings, null, 4)}\n`;
  writeFileSync(join(configDir, "settings.json"), settingsText);
  const stateFile = join(dir, ".claude.json");
  const stateText = JSON.stringify({ numStartups: 3, mcpServers: { other: { command: "x" } } });
  writeFileSync(stateFile, stateText);
  const opts = { configDir, stateFile, shimPath, sievePath, backupRoot: join(dir, "backups") };
  return { dir, configDir, stateFile, opts, settingsText, stateText };
}

describe("claude-code setup", () => {
  test("adds only Sieve's entries, keeps the user's, and backs up first", () => {
    const s = sandbox();
    const r = applySetup(s.opts);
    expect(r.verified).toBe(true);
    const settings = JSON.parse(readFileSync(join(s.configDir, "settings.json"), "utf8"));
    expect(settings.model).toBe("opus");
    expect(settings.hooks.PostToolUse).toHaveLength(2);
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe("prettier --write");
    expect(settings.hooks.PostToolUse[1].hooks[0].command).toBe(`${s.opts.shimPath} claude-code PostToolUse`);
    expect(Object.keys(settings.hooks).sort()).toEqual([
      "PostToolUse",
      "PreCompact",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "SubagentStart",
      "UserPromptSubmit",
    ]);
    const state = JSON.parse(readFileSync(s.stateFile, "utf8"));
    expect(state.numStartups).toBe(3);
    expect(state.mcpServers.other).toEqual({ command: "x" });
    expect(state.mcpServers.sieve.args).toEqual(["mcp"]);
    expect(readFileSync(join(r.backupDir!, "0-settings.json"), "utf8")).toBe(s.settingsText);
    expect(verifySetup(s.opts)).toEqual([]);
  });

  test("running it twice changes nothing the second time", () => {
    const s = sandbox();
    applySetup(s.opts);
    const after = readFileSync(join(s.configDir, "settings.json"), "utf8");
    expect(planSetup(s.opts)).toEqual([]);
    const r = applySetup(s.opts);
    expect(r.changes).toEqual([]);
    expect(r.backupDir).toBeNull();
    expect(readFileSync(join(s.configDir, "settings.json"), "utf8")).toBe(after);
  });

  test("--remove strips Sieve and leaves the user's config equivalent to before", () => {
    const s = sandbox();
    applySetup(s.opts);
    applySetup(s.opts, true);
    expect(JSON.parse(readFileSync(join(s.configDir, "settings.json"), "utf8"))).toEqual(
      JSON.parse(s.settingsText),
    );
    expect(JSON.parse(readFileSync(s.stateFile, "utf8"))).toEqual(JSON.parse(s.stateText));
  });

  test("a failed check rolls every file back, byte for byte", () => {
    const s = sandbox();
    const r = applySetup({ ...s.opts, shimPath: join(s.dir, "missing-shim") });
    expect(r.rolledBack).toBe(true);
    expect(r.error).toContain("shim not found");
    expect(readFileSync(join(s.configDir, "settings.json"), "utf8")).toBe(s.settingsText);
    expect(readFileSync(s.stateFile, "utf8")).toBe(s.stateText);
  });

  test("files that did not exist are removed again on rollback", () => {
    const dir = mkdtempSync(join(tmpdir(), "sieve-cc-"));
    const opts = {
      configDir: join(dir, "c"),
      stateFile: join(dir, "s.json"),
      shimPath: join(dir, "nope"),
      sievePath: "/bin/sh",
      backupRoot: join(dir, "b"),
    };
    const r = applySetup(opts);
    expect(r.rolledBack).toBe(true);
    expect(existsSync(join(dir, "c", "settings.json"))).toBe(false);
    expect(existsSync(join(dir, "s.json"))).toBe(false);
  });

  test("a backup can be restored", () => {
    const s = sandbox();
    const r = applySetup(s.opts);
    restoreBackup(r.backupDir!);
    expect(readFileSync(join(s.configDir, "settings.json"), "utf8")).toBe(s.settingsText);
  });

  test("refuses to touch a settings file that is not valid JSON", () => {
    const s = sandbox();
    writeFileSync(join(s.configDir, "settings.json"), "{ not json");
    expect(() => planSetup(s.opts)).toThrow();
    expect(readFileSync(join(s.configDir, "settings.json"), "utf8")).toBe("{ not json");
  });
});

describe("claude-code event mapping", () => {
  test("maps every registered hook to a shared event", () => {
    const base = { session_id: "s", cwd: "/w" };
    const kinds = [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PreCompact",
      "SubagentStart",
      "Stop",
      "SessionEnd",
    ].map((e) => toEvent(e, { ...base, hook_event_name: e }, 0)?.kind);
    expect(kinds).toEqual([
      "session.start",
      "prompt.submit",
      "tool.before",
      "tool.after",
      "compact.before",
      "subagent.start",
      "turn.end",
      "session.end",
    ]);
  });
  test("reads Bash, MCP and Read results", () => {
    expect(outputText({ stdout: "a", stderr: "b", interrupted: false })).toEqual({
      text: "a\nb",
      isError: false,
    });
    expect(outputText([{ type: "text", text: "x" }, { type: "image" }])).toEqual({
      text: "x",
      isError: false,
    });
    expect(outputText({ type: "text", file: { content: "src" } }).text).toBe("src");
    expect(outputText({ stdout: "", stderr: "", interrupted: true }).isError).toBe(true);
  });
  test("renders a replacement in the original shape and context only where allowed", () => {
    const raw = {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_response: { stdout: "long", stderr: "e", interrupted: false },
    };
    const ev = toEvent("PostToolUse", raw, 0)!;
    const out = JSON.parse(render(ev, { replaceOutput: "receipt" }, raw));
    expect(out.hookSpecificOutput.updatedToolOutput).toEqual({
      stdout: "receipt",
      stderr: "",
      interrupted: false,
    });
    const stop = toEvent("Stop", { hook_event_name: "Stop" }, 0)!;
    expect(render(stop, { context: "nope" }, {})).toBe("");
    expect(archiveId("x")).toMatch(/^s_/);
  });
});

describe("tool response shapes", () => {
  test("Grep content mode is read and replaced in its own shape", async () => {
    const { outputText, replacementFor } = await import("../src/index.ts");
    const grep = { mode: "content", numFiles: 2, filenames: [], content: "a.ts:1:x\nb.ts:2:y", numLines: 2 };
    expect(outputText(grep).text).toBe("a.ts:1:x\nb.ts:2:y");
    expect(replacementFor(grep, "R")).toEqual({ ...grep, content: "R" });
  });
  test("Grep file lists are read but never rewritten", async () => {
    const { outputText, replacementFor } = await import("../src/index.ts");
    const files = { mode: "files_with_matches", numFiles: 2, filenames: ["a.ts", "b.ts"] };
    expect(outputText(files).text).toBe("a.ts\nb.ts");
    expect(replacementFor(files, "R")).toBeUndefined();
  });
  test("unknown object shapes are never replaced", async () => {
    const { replacementFor, render, toEvent } = await import("../src/index.ts");
    expect(replacementFor({ weird: 1 }, "R")).toBeUndefined();
    const raw = { hook_event_name: "PostToolUse", tool_name: "X", tool_response: { weird: 1 } };
    expect(render(toEvent("PostToolUse", raw, 0)!, { replaceOutput: "R" }, raw)).toBe("");
  });
});
