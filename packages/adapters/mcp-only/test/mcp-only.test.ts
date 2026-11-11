import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applySetup } from "@sieve/adapter-kit";
import { INSTRUCTION_SNIPPET, kiroSetup, zedSetup } from "../src/index.ts";

const home = () => mkdtempSync("/tmp/sv-mcp-");
const opts = (h: string) => ({
  home: h,
  shimPath: "/x/sieve-hook",
  sievePath: "/x/sieve",
  backupDir: join(h, "bk"),
});

describe("MCP-only agents", () => {
  test("Kiro: an mcpServers entry is merged into the user's file, idempotently, and removed cleanly", () => {
    const h = home();
    const f = join(h, ".kiro", "settings", "mcp.json");
    mkdirSync(join(h, ".kiro", "settings"), { recursive: true });
    writeFileSync(f, JSON.stringify({ mcpServers: { other: { command: "o" } } }));
    expect(kiroSetup.detect(h)).toBe(true);
    const plan = kiroSetup.plan(opts(h));
    expect(plan).toHaveLength(1);
    const after = JSON.parse(plan[0]!.after);
    expect(after.mcpServers.other).toEqual({ command: "o" }); // the user's server is untouched
    expect(after.mcpServers.sieve).toEqual({ command: "/x/sieve", args: ["mcp"], env: {}, disabled: false });
    writeFileSync(f, plan[0]!.after);
    expect(kiroSetup.plan(opts(h))).toEqual([]); // second run changes nothing
    const rm = JSON.parse(kiroSetup.plan(opts(h), true)[0]!.after);
    expect(rm).toEqual({ mcpServers: { other: { command: "o" } } });
  });

  test("Zed: context_servers entry with command, args, env", () => {
    const h = home();
    mkdirSync(join(h, ".config", "zed"), { recursive: true });
    const plan = zedSetup.plan(opts(h));
    expect(JSON.parse(plan[0]!.after)).toEqual({
      context_servers: { sieve: { command: "/x/sieve", args: ["mcp"], env: {} } },
    });
    expect(plan[0]!.file).toBe(join(h, ".config", "zed", "settings.json"));
  });

  test("a settings file Sieve cannot parse (comments) is left alone, not overwritten", () => {
    const h = home();
    mkdirSync(join(h, ".config", "zed"), { recursive: true });
    const f = join(h, ".config", "zed", "settings.json");
    writeFileSync(f, '// my settings\n{ "theme": "One" }\n');
    expect(() => zedSetup.plan(opts(h))).toThrow();
    expect(readFileSync(f, "utf8")).toContain("// my settings");
  });

  test("a commented settings file: setup says why and gives the block to paste; verify still reads it", () => {
    const h = home();
    mkdirSync(join(h, ".config", "zed"), { recursive: true });
    const f = join(h, ".config", "zed", "settings.json");
    writeFileSync(f, '// my settings\n{ "theme": "One", }\n');
    let msg = "";
    try {
      zedSetup.plan(opts(h));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("comments or trailing commas");
    expect(msg).toContain('"context_servers"');
    expect(msg).toContain('"/x/sieve"');
    // verify reads comments and trailing commas instead of reporting the file as unreadable
    expect(zedSetup.verify(opts(h))).toEqual([`MCP server "sieve" is not registered in ${f}`]);
    writeFileSync(f, '// mine\n{ "context_servers": { "sieve": { "command": "/bin/sh", }, }, }\n');
    expect(zedSetup.verify(opts(h))).toEqual([]);
  });

  test("a commented file already in the wanted state is not a failure: the hand merge converges", () => {
    const h = home();
    mkdirSync(join(h, ".config", "zed"), { recursive: true });
    const f = join(h, ".config", "zed", "settings.json");
    const entry = '{ "command": "/x/sieve", "args": ["mcp"], "env": {}, }';
    writeFileSync(f, `// pasted by hand\n{ "theme": "One", "context_servers": { "sieve": ${entry} } }\n`);
    expect(zedSetup.plan(opts(h))).toEqual([]); // already set up
    expect(() => zedSetup.plan(opts(h), true)).toThrow("by hand"); // removing needs a write
    writeFileSync(f, '{ "theme": "One", } // trailing comma only\n');
    expect(zedSetup.plan(opts(h), true)).toEqual([]); // already removed
    expect(() => zedSetup.plan(opts(h))).toThrow("comments or trailing commas");
  });

  test("verify reports a missing entry and a missing binary; the snippet is offered, never written", () => {
    const h = home();
    mkdirSync(join(h, ".kiro", "settings"), { recursive: true });
    expect(kiroSetup.verify(opts(h))[0]).toContain("is not registered"); // no file yet
    writeFileSync(join(h, ".kiro", "settings", "mcp.json"), "{}");
    expect(kiroSetup.verify(opts(h))[0]).toContain('"sieve" is not registered');
    writeFileSync(
      join(h, ".kiro", "settings", "mcp.json"),
      JSON.stringify({ mcpServers: { sieve: { command: "/no/such" } } }),
    );
    expect(kiroSetup.verify(opts(h))[0]).toContain("MCP command not found");
    expect(kiroSetup.after).toContain(INSTRUCTION_SNIPPET);
    expect(INSTRUCTION_SNIPPET).toContain("sieve_resume");
    expect(zedSetup.support).toBe("preview");
    void applySetup;
  });
});
