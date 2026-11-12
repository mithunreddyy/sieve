import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyPurge, loadConfig } from "@sieve/core";
import { PROTOCOL_VERSION, type ToolResult } from "@sieve/protocol";
import { Daemon } from "../src/index.ts";
import { freshHome } from "./helpers.ts";

const DAY = 86_400_000;
let env: ReturnType<typeof freshHome>;
let project: string;

beforeAll(() => {
  env = freshHome();
  project = join(env.home, "proj");
  mkdirSync(project);
});
afterAll(() => env.cleanup());

async function start(config?: string) {
  if (config !== undefined) writeFileSync(join(env.home, "config.toml"), config);
  const d = new Daemon({
    idleMinutes: 0,
    socketPath: join(env.home, `${Math.random().toString(36).slice(2, 8)}.sock`),
    lockPath: join(env.home, `${Math.random().toString(36).slice(2, 8)}.lock`),
    log: () => {},
  });
  expect(await d.start()).toBe(true);
  const call = async (tool: string, args: unknown) => {
    const r = await d.handleLine(
      JSON.stringify({ v: PROTOCOL_VERSION, id: "t", type: "tool", tool, args, cwd: project }),
    );
    if (!r.ok) return { ok: false as const, text: r.error.message };
    const res = r.result as ToolResult;
    return { ok: !res.isError, text: res.content };
  };
  return { d, call };
}
const text = (tag: string) =>
  `${tag}\n${Array.from({ length: 300 }, (_, i) => `row ${i} ${tag} lorem ipsum dolor`).join("\n")}`;
const archiveOld = (d: Daemon, body: string, daysAgo: number) => {
  const { ref, store } = d.ctx.project(project);
  const item = store.put(body, {
    sessionId: "s",
    worktree: ref.worktree,
    agent: "claude-code",
    sourceKind: "tool",
    source: "Bash: x",
  });
  store.db.run("UPDATE archive SET last_read_at = ? WHERE id = ?", [Date.now() - daysAgo * DAY, item.id]);
  return item;
};

describe("config", () => {
  test("retention is off unless asked for", () => {
    expect(loadConfig(join(env.home, "none.toml")).archive.retention_days).toBe(0);
  });
  test("an unknown key in [archive] is an error, not silently ignored", () => {
    writeFileSync(join(env.home, "bad.toml"), "[archive]\nretention = 30\n");
    expect(() => loadConfig(join(env.home, "bad.toml"))).toThrow();
  });
});

describe("what sieve_get says about an id that no longer expands", () => {
  test("a purged id: says it was removed, when and how, and never claims an expiry that does not exist", async () => {
    const { d, call } = await start("");
    try {
      const item = archiveOld(d, text("purged"), 1);
      const { store } = d.ctx.project(project);
      applyPurge(store, { kind: "project" }, "purge", Date.UTC(2026, 10, 11));
      const r = await call("sieve_get", { id: item.id });
      expect(r.ok).toBe(false);
      expect(r.text).toContain(item.id);
      expect(r.text).toContain("removed on 2026-11-11");
      expect(r.text).toContain("sieve purge");
      expect(r.text).not.toContain("30 days");
    } finally {
      await d.stop();
    }
  });

  test("an id that was never archived here: unknown, with no made-up reason", async () => {
    const { d, call } = await start("");
    try {
      const r = await call("sieve_get", { id: "s_aaaaaaaaaaaa" });
      expect(r.ok).toBe(false);
      expect(r.text).toContain("Unknown id s_aaaaaaaaaaaa");
      expect(r.text).not.toContain("expired");
      expect(r.text).not.toContain("30 days");
    } finally {
      await d.stop();
    }
  });
});

describe("retention", () => {
  test("off (the default): nothing is ever removed", async () => {
    const { d } = await start("");
    try {
      const old = archiveOld(d, text("ancient"), 400);
      expect(d.ctx.retentionAll()).toBe(0);
      expect(d.ctx.project(project).store.get(old.id)).not.toBeNull();
    } finally {
      await d.stop();
    }
  });

  test("on: items unread for the period are removed, recent ones stay, and sieve_get says why", async () => {
    const { d, call } = await start("[archive]\nretention_days = 30\n");
    try {
      const old = archiveOld(d, text("old"), 60);
      const fresh = archiveOld(d, text("fresh"), 5);
      expect(d.ctx.retentionAll()).toBe(1);
      const r = await call("sieve_get", { id: old.id });
      expect(r.ok).toBe(false);
      expect(r.text).toContain("retention");
      expect((await call("sieve_get", { id: fresh.id })).ok).toBe(true);
    } finally {
      await d.stop();
    }
  });

  test("reading an item counts: one read last week keeps it past the period", async () => {
    const { d, call } = await start("[archive]\nretention_days = 30\n");
    try {
      const item = archiveOld(d, text("kept alive"), 60);
      expect((await call("sieve_get", { id: item.id })).ok).toBe(true); // the read refreshes it
      expect(d.ctx.retentionAll()).toBe(0);
      expect((await call("sieve_get", { id: item.id })).ok).toBe(true);
    } finally {
      await d.stop();
    }
  });
});

describe("retention in bounded steps", () => {
  test("a project with many eligible items is worked off 50 at a time, so no one task stalls hooks", async () => {
    const { d } = await start("[archive]\nretention_days = 30\n");
    try {
      for (let i = 0; i < 120; i++) archiveOld(d, text(`bulk-${i}`), 60);
      const keep = archiveOld(d, text("recent"), 2);
      const steps: number[] = [];
      for (;;) {
        const r = d.ctx.retentionStep();
        steps.push(r.removed);
        if (!r.more) break;
      }
      expect(steps).toEqual([50, 50, 20]);
      expect(d.ctx.project(project).store.get(keep.id)).not.toBeNull();
      expect(d.ctx.retentionAll()).toBe(0);
    } finally {
      await d.stop();
    }
  });
});

describe("sieve_stats", () => {
  test("keeps an all-time line from the database, so it survives a daemon restart", async () => {
    const { d, call } = await start("");
    try {
      const { store } = d.ctx.project(project);
      const base = { agent: "claude-code", tool: "Bash", sessionId: "s" };
      store.recordFold({ ...base, at: Date.UTC(2026, 9, 1), kind: "fold", tokensIn: 1000, tokensOut: 100 });
      store.recordFold({ ...base, at: Date.UTC(2026, 9, 2), kind: "rerun", tokensIn: 500, tokensOut: 50 });
      store.recordFold({ ...base, at: Date.UTC(2026, 9, 3), kind: "pass", tokensIn: 700, tokensOut: 700 }); // not a saving
      const r = await call("sieve_stats", {});
      expect(r.text).toContain("Since the daemon started: 0 fold(s)"); // this daemon has done nothing yet
      expect(r.text).toContain(
        "All time in this project: 2 result(s) shortened, 1,500 tokens in → 150 returned (90% fewer), since 2026-10-01.",
      );
    } finally {
      await d.stop();
    }
  });
  test("what Sieve added to context is counted against what it saved, with a net figure", async () => {
    const { d, call } = await start("");
    try {
      const { store } = d.ctx.project(project);
      store.db.run("DELETE FROM folds");
      store.db.run("DELETE FROM injections");
      const base = { agent: "claude-code", tool: "Bash", sessionId: "s" };
      store.recordFold({ ...base, at: Date.UTC(2026, 9, 1), kind: "fold", tokensIn: 1000, tokensOut: 100 });
      store.recordInjection({
        at: Date.UTC(2026, 9, 1),
        sessionId: "s",
        agent: "claude-code",
        event: "prompt.submit",
        kind: "context",
        tokens: 120,
      });
      store.recordInjection({
        at: Date.UTC(2026, 9, 1),
        sessionId: "s",
        agent: "claude-code",
        event: "tool.before",
        kind: "decision",
        tokens: 80,
      });
      const r = await call("sieve_stats", {});
      expect(r.text).toContain(
        "Added to context by Sieve in this project: 120 tokens in 1 reply (recall, state, memory, notices), and 80 tokens in place of 1 declined read or command.",
      );
      expect(r.text).toContain(
        "Net: 700 tokens fewer (900 saved on shortened results, minus 200 added; savings from declined reads are not counted).",
      );
    } finally {
      await d.stop();
    }
  });

  test("with nothing shortened yet it says so", async () => {
    const { d, call } = await start("");
    try {
      d.ctx.project(project).store.db.run("DELETE FROM folds"); // the previous test's rows are in this database
      expect((await call("sieve_stats", {})).text).toContain(
        "All time in this project: nothing shortened yet.",
      );
    } finally {
      await d.stop();
    }
  });
});

describe("frames the shim spooled while the daemon was down", () => {
  test("on start the daemon replays a fresh prompt (and a session start), never a tool event, and clears the spool", async () => {
    const dir = join(env.home, "run", "spool");
    mkdirSync(dir, { recursive: true });
    const frame = (event: string, input: unknown) =>
      `${JSON.stringify({ v: 1, id: "h", type: "hook", agent: "claude-code", event, input })}\n`;
    const ns = (msAgo: number) => `${BigInt(Date.now() - msAgo) * 1_000_000n}`;
    writeFileSync(
      join(dir, `${ns(2000)}-1.frame`),
      frame("SessionStart", {
        session_id: "sp",
        cwd: project,
        hook_event_name: "SessionStart",
        source: "startup",
      }),
    );
    writeFileSync(
      join(dir, `${ns(1500)}-1.frame`),
      frame("UserPromptSubmit", {
        session_id: "sp",
        cwd: project,
        hook_event_name: "UserPromptSubmit",
        prompt: "email of the user whose id is 137",
      }),
    );
    writeFileSync(
      join(dir, `${ns(1000)}-1.frame`),
      frame("PostToolUse", {
        session_id: "sp",
        cwd: project,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "x" },
        tool_response: { stdout: "y".repeat(9000), stderr: "", interrupted: false },
      }),
    );
    writeFileSync(
      join(dir, `${ns(20 * 60_000)}-1.frame`),
      frame("UserPromptSubmit", {
        session_id: "old",
        cwd: project,
        hook_event_name: "UserPromptSubmit",
        prompt: "a stale prompt",
      }),
    );
    const { d } = await start("");
    try {
      expect(d.ctx.lastPrompt.get("sp")).toContain("137");
      expect(d.ctx.lastPrompt.has("old")).toBe(false); // older than 10 minutes: dropped
      const { store } = d.ctx.project(project);
      expect(
        (store.db.query("SELECT COUNT(*) AS n FROM folds WHERE session_id = 'sp'").get() as { n: number }).n,
      ).toBe(0);
      expect(readdirSync(dir).filter((n) => n.endsWith(".frame"))).toEqual([]);
    } finally {
      await d.stop();
    }
  });
});
