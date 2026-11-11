import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Daemon, skipReason, suggest } from "../src/index.ts";
import { freshHome, runShim } from "./helpers.ts";

let env: ReturnType<typeof freshHome>;
let daemon: Daemon;
let repo: string;
let script: string;
let seen: string;

beforeAll(async () => {
  env = freshHome();
  repo = join(env.home, "repo");
  mkdirSync(repo, { recursive: true });
  seen = join(env.home, "seen.jsonl");
  script = join(env.home, "model.sh");
  // a stand-in "model": records what it was sent, answers with fixed JSON
  writeFileSync(
    script,
    `#!/bin/sh\ncat >> "${seen}"; echo >> "${seen}"\nprintf '%s' '{"facts":[{"subject":"api","predicate":"test cmd","object":"bun test"},{"subject":"me","predicate":"prefers","object":"short answers","scope":"everywhere"}]}'\n`,
  );
  chmodSync(script, 0o755);
  daemon = new Daemon({ idleMinutes: 0, log: () => {} });
  expect(await daemon.start()).toBe(true);
});
afterAll(async () => {
  await daemon.stop();
  env.cleanup();
});

const hook = (session: string, event: string, extra: Record<string, unknown> = {}) =>
  runShim({ session_id: session, cwd: repo, hook_event_name: event, ...extra }, {}, event);
const turn = async (session: string, text: string) => {
  await hook(session, "UserPromptSubmit", { prompt: text });
  await hook(session, "Stop");
  await settle();
};
const settle = async () => {
  await daemon.ctx.queue.drain();
  await Promise.all([...daemon.ctx.inflight]);
};
const use = (provider: "off" | "command" | "ollama", extra: Record<string, unknown> = {}) => {
  daemon.ctx.config.memory.extraction = {
    provider,
    command: [script],
    model: "m",
    url: "http://127.0.0.1:1",
    timeout_ms: 5000,
    ...extra,
  } as never;
};
const sent = () => (existsSync(seen) ? readFileSync(seen, "utf8").split("\n").filter(Boolean) : []);

describe("opt-in fact extraction", () => {
  test("off by default: nothing is sent anywhere", async () => {
    use("off");
    await turn("E0", "we deploy with fly.io from the main branch");
    expect(sent()).toHaveLength(0);
    expect(daemon.ctx.global.memory.counts().active).toBe(0);
  });

  test("with a command provider, suggested facts are stored as inferred, by 'model'", async () => {
    use("command");
    await turn("E1", "we deploy with fly.io from the main branch");
    expect(sent()).toHaveLength(1);
    const payload = JSON.parse(sent()[0]!);
    expect(payload.prompt).toBe("we deploy with fly.io from the main branch");
    expect(payload.instructions).toContain("at most 5");
    const facts = (
      daemon.ctx.global.memory as never as { active(w: object): Array<Record<string, unknown>> }
    ).active({
      key: daemon.ctx.project(repo).ref.key,
      root: daemon.ctx.project(repo).ref.root,
      worktree: daemon.ctx.project(repo).ref.worktree,
    });
    expect(facts.map((f) => [f.predicate, f.object, f.trust, f.writer, f.scope])).toEqual([
      ["test_command", "bun test", "inferred", "model", "repo"],
      ["prefers", "short answers", "inferred", "model", "everywhere"],
    ]);
  });

  test("inferred facts never reach the always-on block", async () => {
    const ref = daemon.ctx.project(repo).ref;
    expect(daemon.ctx.global.memory.core({ key: ref.key, root: ref.root, worktree: ref.worktree })).toEqual(
      [],
    );
  });

  test("the same prompt is not sent twice", async () => {
    use("command");
    const before = sent().length;
    await hook("E1", "Stop");
    await settle();
    expect(sent()).toHaveLength(before);
  });

  test("a prompt containing a credential is never sent", async () => {
    use("command");
    const before = sent().length;
    await turn("E2", `the deploy key is ${"sk"}_live_${"Ab12Cd34Ef56Gh78"} remember it`);
    expect(sent()).toHaveLength(before);
  });

  test("secrets in the session activity are masked before they go out", async () => {
    use("command");
    await hook("E3", "UserPromptSubmit", { prompt: "run the build please" });
    await hook("E3", "PostToolUse", {
      tool_name: "Bash",
      tool_input: {
        command: `curl -H "Authorization: Bearer ${"gh"}p_${"a1B2c3D4e5".repeat(4)}" https://x.test`,
      },
      tool_response: { stdout: "ok", stderr: "", interrupted: false },
    });
    await hook("E3", "Stop");
    await settle();
    const last = sent().at(-1)!;
    expect(last).not.toContain(`${"gh"}p_`);
  });

  test("a model that answers badly stores nothing and the agent is unaffected", async () => {
    use("command", { command: ["/bin/sh", "-c", "cat >/dev/null; echo not json"] });
    const before = daemon.ctx.global.memory.counts().active;
    const errs = daemon.ctx.counters.sessionErrors;
    await turn("E4", "another thing worth knowing about the repo");
    expect(daemon.ctx.global.memory.counts().active).toBe(before);
    expect(daemon.ctx.counters.sessionErrors).toBe(errs + 1);
  });

  test("more than five facts are cut to five; a hung command is killed", async () => {
    const many = JSON.stringify({
      facts: Array.from({ length: 9 }, (_, i) => ({ subject: "s", predicate: "note", object: `n${i}` })),
    });
    use("command", { command: ["/bin/sh", "-c", `cat >/dev/null; printf '%s' '${many}'`] });
    const out = await suggest(daemon.ctx, { prompt: "x", activity: [] });
    expect(out).toHaveLength(5);
    use("command", { command: ["/bin/sh", "-c", "sleep 30"], timeout_ms: 1000 });
    await expect(suggest(daemon.ctx, { prompt: "x", activity: [] })).rejects.toThrow("timed out");
  });

  test("the ollama provider refuses a server that is not on this machine", async () => {
    use("ollama", { url: "http://models.example.com:11434" });
    await expect(suggest(daemon.ctx, { prompt: "x", activity: [] })).rejects.toThrow("on this machine");
  });

  test("skip reasons", () => {
    expect(skipReason({ prompt: "  ", activity: [] })).toBe("no new user text");
    expect(skipReason({ prompt: "fine", activity: [] })).toBeNull();
  });
});

void rmSync;
