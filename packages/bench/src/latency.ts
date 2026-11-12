import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../../..");
const SHIM = join(REPO, "dist", "sieve-hook");
const SIEVE = join(REPO, "dist", "sieve");

export interface LatencyRow {
  case: string;
  n: number;
  /** How many calls got a reply (a fold, a declined read, context) rather than a pass-through. */
  replied: number;
  p50: number;
  p99: number;
  max: number;
}

function pct(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]! * 100) / 100;
}

async function call(
  cmd: string[],
  input: string,
  env: Record<string, string>,
): Promise<{ ms: number; out: string }> {
  const t0 = performance.now();
  const p = Bun.spawn(cmd, {
    stdin: Buffer.from(input),
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, ...env },
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return { ms: performance.now() - t0, out };
}

/**
 * End-to-end hook latency as the agent sees it: process exec of the shim → daemon → stdout.
 * Warm = daemon running. Cold = no daemon (the shim passes through and starts one).
 */
export async function runLatency(n = 300): Promise<LatencyRow[]> {
  if (!existsSync(SHIM) || !existsSync(SIEVE)) throw new Error("run `bun run build` first");
  const home = mkdtempSync("/tmp/svb-");
  // CLAUDE_CONFIG_DIR: a Claude config with no `sieve setup` hooks, so the plugin route acts.
  const env = {
    SIEVE_HOME: home,
    SIEVE_BIN: SIEVE,
    SIEVE_HOOK_TIMEOUT_MS: "1000",
    CLAUDE_CONFIG_DIR: join(home, "claude"),
  };
  const cwd = join(home);
  const small = JSON.stringify({
    session_id: "b",
    cwd,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  });
  const big = (i: number) =>
    JSON.stringify({
      session_id: "b",
      cwd,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test", description: "run tests" },
      tool_response: {
        stdout: Array.from({ length: 1500 }, (_, k) => `PASS case ${k} iteration ${i} (${k % 13} ms)`).join(
          "\n",
        ),
        stderr: "",
        interrupted: false,
      },
    });
  const repo = join(home, "repo");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(repo);
  writeFileSync(
    join(repo, "routes.ts"),
    Array.from(
      { length: 1800 },
      (_, i) => `export function handler${i}(req: Request) { return limitRate(req, ${i}); }`,
    ).join("\n"),
  );
  const readPre = JSON.stringify({
    session_id: "b",
    cwd: repo,
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: join(repo, "routes.ts") },
  });
  const rows: LatencyRow[] = [];
  const measure = async (name: string, cmd: string[], input: (i: number) => string, count: number) => {
    const xs: number[] = [];
    let replied = 0;
    for (let i = 0; i < count; i++) {
      const r = await call(cmd, input(i), env);
      xs.push(r.ms);
      if (r.out.trim()) replied++;
    }
    rows.push({
      replied,
      case: name,
      n: count,
      p50: pct(xs, 0.5),
      p99: pct(xs, 0.99),
      max: Math.round(Math.max(...xs) * 100) / 100,
    });
  };
  try {
    // Cold: no daemon. Measures the pass-through path including the detached spawn.
    await measure(
      "go shim, cold (no daemon, pass-through)",
      [SHIM, "claude-code", "PreToolUse"],
      () => small,
      1,
    );
    for (let i = 0; i < 100 && !existsSync(join(home, "run", "sieved.sock")); i++) await Bun.sleep(20);
    for (let i = 0; i < 20; i++) await call([SHIM, "claude-code", "PreToolUse"], small, env); // warm up
    await measure("go shim, warm, PreToolUse (small)", [SHIM, "claude-code", "PreToolUse"], () => small, n);
    await measure(
      "go shim, warm, PostToolUse 60 KB → receipt",
      [SHIM, "claude-code", "PostToolUse"],
      big,
      Math.min(n, 100),
    );
    // The Claude Code plugin's route: hooks/run.sh finds the binaries in $SIEVE_HOME/bin and execs the shim.
    const { symlinkSync } = await import("node:fs");
    mkdirSync(join(home, "bin"));
    symlinkSync(SHIM, join(home, "bin", "sieve-hook"));
    symlinkSync(SIEVE, join(home, "bin", "sieve"));
    const pluginHook = join(import.meta.dir, "..", "..", "..", "plugins", "sieve", "hooks", "run.sh");
    await measure(
      "plugin route (run.sh → go shim), warm, PreToolUse (small)",
      [pluginHook, "PreToolUse"],
      () => small,
      n,
    );
    await measure(
      "plugin route (run.sh → go shim), warm, PostToolUse 60 KB → receipt",
      [pluginHook, "PostToolUse"],
      big,
      Math.min(n, 100),
    );
    await measure(
      "go shim, warm, PreToolUse Read 100 KB file (outline / pass)",
      [SHIM, "claude-code", "PreToolUse"],
      () => readPre,
      Math.min(n, 100),
    );
    // Guard parses every Bash command on PreToolUse; these are the expensive shapes: a wrapper
    // chain with several commands, and a script lookup that reads package.json from disk.
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ scripts: { ship: "tsc && node dist/cli.js --prod && echo done" } }),
    );
    const pre = (command: string) =>
      JSON.stringify({
        session_id: "b",
        cwd: repo,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      });
    const chain = pre(
      "sudo -u ci bash -lc 'cd /srv/app && git pull --rebase && npm ci && npm run build && rsync -a dist/ deploy@host:/var/www/'",
    );
    await measure(
      "go shim, warm, PreToolUse Bash through Guard (wrapper chain, 5 commands)",
      [SHIM, "claude-code", "PreToolUse"],
      () => chain,
      Math.min(n, 100),
    );
    const script = pre("npm run ship");
    await measure(
      "go shim, warm, PreToolUse Bash through Guard (reads package.json script)",
      [SHIM, "claude-code", "PreToolUse"],
      () => script,
      Math.min(n, 100),
    );

    // Recall searches the archive on every prompt with a file name, identifier or error text.
    // Another session, so the 60 KB outputs above are eligible and pointers are returned.
    const recallPrompt = (i: number) =>
      JSON.stringify({
        session_id: `r${i}`,
        cwd,
        hook_event_name: "UserPromptSubmit",
        prompt: `why does handlerTimeout fail in widget.test.ts? I saw "case ${i % 1500} iteration" twice`,
      });
    await measure(
      "go shim, warm, UserPromptSubmit with recall (log + search)",
      [SHIM, "claude-code", "UserPromptSubmit"],
      recallPrompt,
      Math.min(n, 100),
    );
    // Memory and skills add work to the first prompt of a session: facts are ranked against the
    // prompt, and a matching skill is read from disk and checksummed. 40 facts, 3 skills.
    {
      const { GlobalStore, Skills, resolveProject } = await import("@sieve/core");
      const ref = resolveProject(cwd);
      const gs = new GlobalStore(join(home, "global.db"));
      const where = { key: ref.key, root: ref.root, worktree: ref.worktree };
      for (let i = 0; i < 40; i++)
        gs.memory.remember(
          {
            subject: `module ${i}`,
            predicate: "note",
            object: `handler${i} limits requests per minute`,
            writer: "user",
            at: Date.now(),
          },
          where,
        );
      gs.close();
      const skills = new Skills(join(home, "skills"));
      for (const [name, desc] of [
        ["db-migrations", "Plan and review database schema migrations safely"],
        ["commit-style", "Write conventional commit messages and changelog entries"],
        ["pdf-forms", "Fill in and extract PDF forms and fields"],
      ] as const) {
        const d = mkdtempSync("/tmp/svb-skill-");
        writeFileSync(
          join(d, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${desc}\n---\n${"Step one.\n".repeat(200)}`,
        );
        skills.add(d);
        skills.setEnabled(name, true);
        rmSync(d, { recursive: true, force: true });
      }
      const memPrompt = (i: number) =>
        JSON.stringify({
          session_id: `m${i}`,
          cwd,
          hook_event_name: "UserPromptSubmit",
          prompt: `review this database schema migration, and why does handler${i % 40} limit requests per minute?`,
        });
      await measure(
        "go shim, warm, first UserPromptSubmit with memory facts + a matching skill (40 facts, 3 skills)",
        [SHIM, "claude-code", "UserPromptSubmit"],
        memPrompt,
        Math.min(n, 100),
      );
    }
    // These come last: they write ~15 MB of files, and disk activity right before a call spikes the
    // daemon's own writes (measured), which would perturb the rows after them.
    // A result Claude Code cut at 30 KB and kept whole in a file (the common big-output case in
    // Claude Code): the hook reads that file, archives all of it and returns a 2 KB receipt.
    const { writeFileSync: write } = await import("node:fs");
    const tdir = join(home, "claude", "projects", "-p", "sb", "tool-results");
    mkdirSync(tdir, { recursive: true });
    // The files are written up front: writing one just before each call makes the daemon's own disk
    // writes spike by 40-60 ms (measured with a control: the same spikes appear with the output sent
    // inline), which would measure the harness. Claude Code writes the file itself, with or without Sieve.
    const persisted = (kbytes: number, count: number) => {
      const lines = Math.ceil((kbytes * 1024) / 45);
      const payloads = Array.from({ length: count }, (_, i) => {
        const full = Array.from(
          { length: lines },
          (_, k) => `PASS case ${k} iteration ${i} lorem ipsum dolor`,
        ).join("\n");
        const file = join(tdir, `p${kbytes}-${i}.txt`);
        write(file, full);
        return JSON.stringify({
          session_id: "sb",
          cwd,
          hook_event_name: "PostToolUse",
          transcript_path: join(home, "claude", "projects", "-p", "sb.jsonl"),
          tool_name: "Bash",
          tool_input: { command: "npm test", description: "run tests" },
          tool_response: {
            stdout: full.slice(0, 29_999),
            stderr: "",
            interrupted: false,
            persistedOutputPath: file,
            persistedOutputSize: Buffer.byteLength(full),
          },
        });
      });
      return (i: number) => payloads[i % count]!;
    };
    // The common case first (it is gated like every warm row), then larger ones with their own gate,
    // then one over the read bound, which is not read at all and so must cost almost nothing.
    const p60 = persisted(60, Math.min(n, 100) + 10);
    await Bun.sleep(300); // let the disk settle after the writes
    for (let i = 0; i < 5; i++) await call([SHIM, "claude-code", "PostToolUse"], p60(100 + i), env);
    await measure(
      "go shim, warm, PostToolUse 60 KB kept whole in a file → 2 KB receipt",
      [SHIM, "claude-code", "PostToolUse"],
      p60,
      Math.min(n, 100),
    );
    for (const [kbytes, what] of [
      [250, "250 KB (just under the read bound)"],
      [600, "600 KB (over the bound: not read, archived as a partial)"],
    ] as const) {
      const rows30 = persisted(kbytes, 30);
      await Bun.sleep(2000); // each row starts with the background queue drained, so it measures itself
      await measure(
        `go shim, large, PostToolUse ${what} kept whole in a file → 2 KB receipt`,
        [SHIM, "claude-code", "PostToolUse"],
        rows30,
        30,
      );
    }
    await measure(
      "ts fallback (sieve hook), warm, PreToolUse",
      [SIEVE, "hook", "claude-code", "PreToolUse"],
      () => small,
      20,
    );
  } finally {
    await call([SIEVE, "daemon", "stop"], "", env);
    await Bun.sleep(100);
    rmSync(home, { recursive: true, force: true });
  }
  return rows;
}
