import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Daemon, shouldSteer, steerable } from "../src/index.ts";
import { freshHome, runShim } from "./helpers.ts";

let env: ReturnType<typeof freshHome>;
let daemon: Daemon;
let repo: string;

beforeAll(async () => {
  env = freshHome();
  repo = join(env.home, "repo");
  mkdirSync(repo, { recursive: true });
  daemon = new Daemon({ idleMinutes: 0, log: () => {} });
  expect(await daemon.start()).toBe(true);
});
afterAll(async () => {
  await daemon.stop();
  env.cleanup();
});

async function hook(session: string, event: string, extra: Record<string, unknown>) {
  const r = await runShim({ session_id: session, cwd: repo, hook_event_name: event, ...extra }, {}, event);
  expect(r.code).toBe(0);
  return r.stdout ? JSON.parse(r.stdout) : null;
}
const ran = (s: string, command: string, lines: number) =>
  hook(s, "PostToolUse", {
    tool_name: "Bash",
    tool_input: { command },
    tool_response: {
      stdout: Array.from(
        { length: lines },
        (_, i) => `entry ${i} lorem ipsum dolor sit amet consectetur`,
      ).join("\n"),
      stderr: "",
      interrupted: false,
    },
  });
const pre = (s: string, command: string) =>
  hook(s, "PreToolUse", { tool_name: "Bash", tool_input: { command } });
const denied = (o: any) =>
  o?.hookSpecificOutput?.permissionDecision === "deny"
    ? String(o.hookSpecificOutput.permissionDecisionReason)
    : null;

describe("which commands may be steered", () => {
  test("only provably read-only ones, keyed by program and subcommand", () => {
    expect(steerable("git log --oneline")?.family).toBe("git log");
    expect(steerable("ls -la src")?.family).toBe("ls");
    expect(steerable("kubectl get pods -A | grep api")?.family).toBe("kubectl get");
    for (const c of [
      "git commit -m x",
      "git push",
      "rm -rf build",
      "find . -name '*.o' -delete",
      "sed -i s/a/b/ f.txt",
      "cat a > b",
      "curl https://example.com",
      "npm install",
      "ssh host ls",
      "sudo ls",
      "bun test",
      "echo hi && git log",
    ])
      expect([c, steerable(c)]).toEqual([c, null]);
  });

  test("the history must promise more than twice the cost of one extra call", () => {
    expect(shouldSteer(3000)).toBe(false);
    expect(shouldSteer(3900)).toBe(true);
  });
});

describe("steering a session", () => {
  test("a command that printed a lot is declined once, with a sieve_run call; the repeat goes through", async () => {
    await ran("S1", "git log --stat", 1500); // a few thousand tokens of output
    const first = denied(await pre("S1", "git log --stat"));
    expect(first).toContain("`git log` printed about");
    expect(first).toContain('sieve_run {"language":"shell","code":"git log --stat"');
    expect(first).toContain("send the same command again");
    expect(denied(await pre("S1", "git log --stat"))).toBeNull(); // the same call goes through
    expect(denied(await pre("S1", "git log --stat"))).toBe(first); // and is steerable again afterwards
    expect(daemon.ctx.counters.steered).toBe(2);
  });

  test("a different command of the same family is steered too; another family is not", async () => {
    expect(denied(await pre("S1", "git log --oneline -n 500"))).not.toBeNull();
    expect(denied(await pre("S1", "git status"))).toBeNull();
  });

  test("short output never steers, and commands that act are never steered", async () => {
    await ran("S2", "ls", 10);
    expect(denied(await pre("S2", "ls"))).toBeNull();
    await ran("S2", "git commit -m x", 1500);
    expect(denied(await pre("S2", "git commit -m x"))).toBeNull();
  });

  test("steering off", async () => {
    await ran("S3", "ls -R", 1500);
    daemon.ctx.config.steering.enabled = false;
    try {
      expect(denied(await pre("S3", "ls -R"))).toBeNull();
    } finally {
      daemon.ctx.config.steering.enabled = true;
    }
    expect(denied(await pre("S3", "ls -R"))).not.toBeNull();
  });
});

describe("what the dashboard will read", () => {
  test("every large output leaves a row: folded, with its extractor and token counts", async () => {
    const { store } = daemon.ctx.project(repo);
    const rows = store.db
      .query("SELECT kind, tool, tokens_in AS i, tokens_out AS o FROM folds")
      .all() as Array<{
      kind: string;
      tool: string;
      i: number;
      o: number;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    const folded = rows.filter((r) => r.kind === "fold");
    expect(folded.length).toBeGreaterThan(0);
    for (const r of folded) {
      expect(r.tool).toBe("Bash");
      expect(r.o).toBeLessThan(r.i);
    }
  });
});
