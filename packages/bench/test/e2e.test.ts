import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StatusReport } from "@sieve/protocol";
import { AGENTS, judge, prepare, toolAfterNames } from "../src/agent-e2e.ts";
import { ROWS, renderMatrix } from "../src/matrix.ts";

const fakeBins = () => {
  const d = mkdtempSync(join(tmpdir(), "sv-fb-"));
  const sieve = join(d, "sieve");
  const shim = join(d, "sieve-hook");
  for (const f of [sieve, shim]) {
    writeFileSync(f, "#!/bin/sh\n");
    chmodSync(f, 0o755);
  }
  return { sieve, shim };
};

describe("real-agent harness: where each agent reads its project config", () => {
  const at = (id: string) => AGENTS.find((x) => x.agent === id)!;
  test("OpenCode: project plugin in plugins/, project config in opencode.json (not .opencode/)", () => {
    const { sieve, shim } = fakeBins();
    const p = prepare(at("opencode"), sieve, shim);
    try {
      expect(existsSync(join(p.dir, "plugins", "sieve.ts"))).toBe(true);
      expect(existsSync(join(p.dir, "opencode.json"))).toBe(true);
      expect(existsSync(join(p.dir, ".opencode"))).toBe(false);
    } finally {
      p.cleanup();
    }
  });
  test("Copilot CLI: hooks and mcp-config.json under COPILOT_HOME, which the harness sets", () => {
    const { sieve, shim } = fakeBins();
    const p = prepare(at("copilot-cli"), sieve, shim);
    try {
      expect(p.env.COPILOT_HOME).toBe(join(p.dir, ".copilot"));
      expect(existsSync(join(p.dir, ".copilot", "hooks", "sieve.json"))).toBe(true);
      expect(existsSync(join(p.dir, ".copilot", "mcp-config.json"))).toBe(true);
    } finally {
      p.cleanup();
    }
  });
  test("Gemini CLI and Cursor: project .gemini/settings.json and .cursor/hooks.json + mcp.json", () => {
    const { sieve, shim } = fakeBins();
    const g = prepare(at("gemini-cli"), sieve, shim);
    const c = prepare(at("cursor"), sieve, shim);
    try {
      expect(existsSync(join(g.dir, ".gemini", "settings.json"))).toBe(true);
      expect(existsSync(join(c.dir, ".cursor", "hooks.json"))).toBe(true);
      expect(existsSync(join(c.dir, ".cursor", "mcp.json"))).toBe(true);
    } finally {
      g.cleanup();
      c.cleanup();
    }
  });
});

describe("real-agent harness (offline parts)", () => {
  for (const a of AGENTS) {
    test(`${a.agent}: project-level config is written under the throwaway repo and passes its own check`, () => {
      const { sieve, shim } = fakeBins();
      const p = prepare(a, sieve, shim);
      try {
        expect(p.problems).toEqual([]);
        expect(p.dir.startsWith("/tmp/sv-e2e-")).toBe(true);
        expect(p.env.SIEVE_HOME).toBe(p.home); // never the developer's own daemon
        expect(existsSync(join(p.dir, ".git"))).toBe(true);
        expect(a.argv("x").length).toBeGreaterThan(1);
        expect(toolAfterNames(a).length).toBeGreaterThan(0);
      } finally {
        p.cleanup();
      }
    });
  }

  test("the verdict needs the event that follows a tool call, not just any hook", () => {
    const a = AGENTS.find((x) => x.agent === "gemini-cli")!;
    const status = (events: string[]) =>
      ({
        agents: [{ agent: "gemini-cli", events: events.map((event) => ({ event, count: 2, lastAt: 1 })) }],
      }) as unknown as StatusReport;
    expect(judge(a, status(["SessionStart", "BeforeAgent"]), "0.65.0").passed).toBe(false);
    expect(judge(a, status(["SessionStart", "AfterTool"]), "0.65.0").passed).toBe(true);
    expect(judge(a, null, "").reason).toBe("no hook reached the daemon");
  });
});

describe("support matrix", () => {
  test("without a passing record nothing is verified (Claude Code is live, the rest preview); a record promotes only that agent", () => {
    const none = renderMatrix(new Map());
    expect(none.match(/\| preview \|/g)).toHaveLength(ROWS.length - 1);
    expect(none.match(/\| live \|/g)).toHaveLength(1);
    expect(none).not.toContain("| verified |");
    const one = renderMatrix(
      new Map([
        [
          "gemini-cli",
          {
            agent: "gemini-cli",
            agentVersion: "0.65.0",
            at: "2026-11-11T00:00:00Z",
            passed: true,
            events: [],
            reason: "",
          },
        ],
      ]),
    );
    expect(one.match(/\| verified \|/g)).toHaveLength(1);
    expect(one).toContain(
      "| Gemini CLI | hooks in settings.json + MCP | verified | pass · 0.65.0 · 2026-11-11 |",
    );
    const failed = renderMatrix(
      new Map([
        [
          "cursor",
          {
            agent: "cursor",
            agentVersion: "x",
            at: "2026-11-11T00:00:00Z",
            passed: false,
            events: [],
            reason: "",
          },
        ],
      ]),
    );
    expect(failed).toContain("| Cursor | hooks.json + MCP | preview | FAIL");
  });
  test("capabilities come from the code: Gemini cannot replace, Copilot can", () => {
    const m = renderMatrix(new Map());
    expect(m).toMatch(/\| Gemini CLI .*\| none \| deny \|/);
    expect(m).toMatch(/\| Copilot CLI .*\| all \| deny \/ ask \| session start, next tool result \|/);
  });
});

describe("verdict with no daemon", () => {
  test("a status report without agents (daemon down) is a clear FAIL, not a crash", () => {
    const a = AGENTS.find((x) => x.agent === "gemini-cli")!;
    const noDaemon = { daemon: null, setup: [] } as unknown as StatusReport;
    const r = judge(a, noDaemon, "0.65.0");
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("no hook reached the daemon");
    expect(judge(a, null, "").passed).toBe(false);
  });
});

describe("run helper writes the agent's output to a file", () => {
  test("output and exit code are captured without a pipe", async () => {
    const { run } = await import("../src/agent-e2e.ts");
    const d = mkdtempSync(join(tmpdir(), "sv-run-"));
    const log = join(d, "out.log");
    const r = await run(
      "sh",
      ["-c", "echo hello; echo oops >&2; exit 3"],
      { PATH: process.env.PATH ?? "" },
      d,
      10_000,
      log,
    );
    expect(r.code).toBe(3);
    expect(r.out).toContain("hello");
    expect(r.out).toContain("oops");
  });
  test("a missing binary resolves to a null code instead of throwing", async () => {
    const { run } = await import("../src/agent-e2e.ts");
    const d = mkdtempSync(join(tmpdir(), "sv-run-"));
    const r = await run("/no/such/binary", [], {}, d, 5_000, join(d, "x.log"));
    expect(r.code).toBeNull();
  });
});
