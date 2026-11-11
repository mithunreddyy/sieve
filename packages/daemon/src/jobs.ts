import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import {
  byteLength,
  cleanTerminal,
  describeHits,
  fallbackPlan,
  jobId,
  type ProjectRef,
  type ProjectStore,
  RUN_PREVIEW_BUDGET,
  renderExtraction,
  renderReceipt,
  runExtractors,
} from "@sieve/core";
import type { Observed } from "@sieve/guard";
import { defaultPolicy, describe, type Mode, realish, wrap } from "@sieve/sandbox";
import type { BehaviourWatcher } from "./behaviour.ts";

export const RUN_LIMITS = {
  defaultTimeoutMs: 600_000,
  maxTimeoutMs: 600_000,
  /** Output up to this size is returned whole. */
  returnCap: 16 * 1024,
  /** Bytes kept in memory per run; beyond this the middle is dropped and the receipt says so. */
  memoryCap: 64 * 1024 * 1024,
  killGraceMs: 2000,
} as const;

export interface RunRequest {
  language: string;
  code: string;
  file?: string;
  intent?: string;
  timeoutMs?: number;
  background?: boolean;
  /** Hosts the code needs: any entry turns the network on (all hosts; not filtered). */
  network?: string[];
  /** Extra folders the code may write to. */
  writable?: string[];
  /** Environment variable names to pass through. */
  env?: string[];
}

/** Where a run is allowed to write, and how strictly it is isolated. */
export interface SandboxContext {
  /** The worktree, and the git common dir's root for linked worktrees. */
  project: string[];
  mode: Mode;
  /** Never readable by the code, besides the usual credential folders (e.g. SIEVE_HOME). */
  denyRead?: string[];
  /** Guard's behaviour checks: clauses to put in the profile, and the watcher that records the run. */
  behaviour?: { report: string[]; deny: string[]; watcher: BehaviourWatcher };
}

interface Lang {
  ext: string;
  argv: (script: string) => string[];
  env?: Record<string, string>;
}

const compiled = () => Bun.main.startsWith("/$bunfs") || Bun.main.startsWith("B:\\~BUN");

function language(name: string): Lang {
  const l = name.toLowerCase();
  switch (l) {
    case "shell":
    case "sh":
    case "bash":
      return process.platform === "win32"
        ? { ext: ".ps1", argv: (s) => ["powershell", "-NoProfile", "-File", s] }
        : { ext: ".sh", argv: (s) => ["bash", s] };
    case "powershell":
    case "pwsh":
      return { ext: ".ps1", argv: (s) => ["pwsh", "-NoProfile", "-File", s] };
    case "python":
    case "python3":
    case "py":
      return { ext: ".py", argv: (s) => [process.platform === "win32" ? "python" : "python3", s] };
    case "js":
    case "javascript":
    case "ts":
    case "typescript":
      // Sieve's own Bun runs JS/TS, so users need no runtime. A compiled binary acts as bun with BUN_BE_BUN=1.
      return {
        ext: l.startsWith("t") ? ".ts" : ".mjs",
        argv: (s) => [process.execPath, s],
        ...(compiled() ? { env: { BUN_BE_BUN: "1" } } : {}),
      };
    default:
      return { ext: `.${l.replace(/[^a-z0-9]/g, "") || "txt"}`, argv: (s) => [name, s] };
  }
}

export interface RunOutcome {
  /** The isolation that was in force, as described on the receipt. */
  isolation: string;
  /** What the sandbox saw the run do (files, network, programs), when Guard's behaviour checks ran. */
  observed?: Observed[];
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
  truncatedBytes: number;
  spawnError?: string;
}

/** Run a script in its own process group; on timeout the whole tree is killed. */
export function execute(
  req: RunRequest,
  cwd: string,
  onData?: (total: number) => void,
  sb: SandboxContext = { project: [cwd], mode: "auto" },
): {
  done: Promise<RunOutcome>;
  kill: () => void;
  partial: () => string;
} {
  const lang = language(req.language);
  const dir = mkdtempSync(join(tmpdir(), "sieve-run-"));
  const script = join(dir, `script${lang.ext}`);
  writeFileSync(script, req.code, { mode: 0o600 });
  const timeoutMs = Math.min(req.timeoutMs ?? RUN_LIMITS.defaultTimeoutMs, RUN_LIMITS.maxTimeoutMs);
  // The run folder is the scratch space: the script lives in it, TMPDIR points into it, and it
  // is deleted afterwards. Grants are checked before anything starts.
  let wrapped: ReturnType<typeof wrap>;
  try {
    const policy = defaultPolicy(sb.project, dir, {
      writable: (req.writable ?? []).map((w) => resolvePath(cwd, w)),
      network: (req.network?.length ?? 0) > 0,
      networkHosts: req.network ?? [],
      env: req.env ?? [],
    });
    // Seatbelt matches real paths only (macOS /tmp is a symlink), so extras are resolved too.
    // A deny must never cover a folder the run needs (a project inside SIEVE_HOME, say).
    const needed = [...policy.project, policy.scratch, realish(cwd)];
    if (sb.behaviour) {
      policy.reportClauses = sb.behaviour.report;
      policy.denyClauses = sb.behaviour.deny;
    }
    policy.denyRead = [...new Set([...policy.denyRead, ...(sb.denyRead ?? []).map(realish)])].filter(
      (d) => !needed.some((n) => n === d || n.startsWith(`${d}/`)),
    );
    wrapped = wrap(
      lang.argv(script),
      cwd,
      policy,
      process.env,
      { ...(lang.env ?? {}), ...(req.file ? { SIEVE_FILE: req.file } : {}) },
      sb.mode,
    );
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const { cmd, args } = wrapped;
  const started = performance.now();
  const parts: Buffer[] = [];
  let kept = 0;
  let truncatedBytes = 0;
  const tail: Buffer[] = [];
  let tailBytes = 0;

  const since = sb.behaviour?.watcher.position() ?? 0;
  const child = spawn(cmd, args, {
    cwd,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: wrapped.env,
  });
  // The run is its own process group (detached): the watcher attributes sandbox reports to it.
  const recording =
    sb.behaviour && wrapped.level.kind === "seatbelt" && child.pid
      ? sb.behaviour.watcher.begin(child.pid, since)
      : undefined;
  const onChunk = (b: Buffer) => {
    if (kept + b.length <= RUN_LIMITS.memoryCap / 2) {
      parts.push(b);
      kept += b.length;
    } else {
      truncatedBytes += b.length;
      tail.push(b);
      tailBytes += b.length;
      while (tailBytes > RUN_LIMITS.memoryCap / 2 && tail.length > 1) tailBytes -= tail.shift()!.length;
    }
    onData?.(kept + truncatedBytes);
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);

  let timedOut = false;
  const killTree = (sig: NodeJS.Signals) => {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {}
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killTree("SIGTERM");
    setTimeout(() => killTree("SIGKILL"), RUN_LIMITS.killGraceMs).unref();
  }, timeoutMs);

  const assemble = () => {
    const head = Buffer.concat(parts).toString("utf8");
    if (!truncatedBytes) return head;
    const t = Buffer.concat(tail).toString("utf8");
    return `${head}\n[sieve: ${truncatedBytes - tailBytes} bytes dropped from the middle of the stream]\n${t}`;
  };

  const done = new Promise<RunOutcome>((resolve) => {
    let spawnError: string | undefined;
    child.on("error", (e) => {
      spawnError = e.message;
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      // Make sure no grandchild outlives the run.
      killTree("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
      const observed = recording ? await recording.finish().catch(() => undefined) : undefined;
      resolve({
        isolation: describe(wrapped.level),
        ...(observed ? { observed } : {}),
        exitCode: code,
        signal,
        timedOut,
        durationMs: Math.round(performance.now() - started),
        output: assemble(),
        truncatedBytes: truncatedBytes - tailBytes,
        ...(spawnError ? { spawnError } : {}),
      });
    });
  });
  return { done, kill: () => killTree("SIGKILL"), partial: assemble };
}

/**
 * Render the result of a run. Output up to 16 KB is returned whole. Larger output is archived
 * and a preview is returned (≤ 4 KB on success; on failure up to 16 KB, weighted to the end
 * where errors usually are). The archive id lets the agent expand any part of it.
 */
function renderRunBody(
  o: RunOutcome,
  req: RunRequest,
  store: ProjectStore,
  ref: ProjectRef,
  sessionId: string | null,
): string {
  const status = o.spawnError
    ? `failed to start: ${o.spawnError}`
    : o.timedOut
      ? `timed out after ${(o.durationMs / 1000).toFixed(1)} s (process tree killed)`
      : o.signal
        ? `killed by ${o.signal}`
        : `exit ${o.exitCode}`;
  // Output is masked before it is stored or returned: it may print an environment variable,
  // a .env file or a token the script was handed.
  const masked = store.maskResult(o.output, ref.worktree);
  const hits = describeHits(masked.hits);
  const header = `[sieve run] ${status} · ${(o.durationMs / 1000).toFixed(1)} s · isolation: ${o.isolation}${hits ? ` · ${hits}` : ""}`;
  const text = cleanTerminal(masked.text);
  if (!text) return `${header}\n(no output)`;
  const item = store.put(o.output, {
    masked: masked.text,
    sessionId,
    worktree: ref.worktree,
    agent: null,
    sourceKind: "run",
    source: `${req.language}: ${store.mask(req.code, ref.worktree).replace(/\s+/g, " ").slice(0, 160)}`,
  });
  if (byteLength(text) <= RUN_LIMITS.returnCap) return `${header} · archived ${item.id}\n${text}`;
  const failed = o.exitCode !== 0 || o.timedOut || !!o.signal;
  // A format-aware extraction, if it fits under the 16 KB cap, beats a blind preview.
  const shell = /^(shell|sh|bash|powershell|pwsh)$/i.test(req.language);
  const ex = runExtractors({
    text,
    isError: false,
    budget: 12 * 1024,
    ...(shell ? { command: req.code } : {}),
    ...(req.intent ? { intent: req.intent } : {}),
  });
  if (ex) {
    const receipt = renderExtraction(item, ex, byteLength(o.output));
    if (byteLength(receipt) <= RUN_LIMITS.returnCap) return `${header}\n${receipt}`;
  }
  const budget = failed ? { head: 3072, tail: 9216, intent: 1024, errors: 2048 } : RUN_PREVIEW_BUDGET;
  const plan = fallbackPlan(text, budget, req.intent);
  if (!plan) return `${header} · archived ${item.id}\n${text}`;
  return `${header}\n${renderReceipt(item, plan, byteLength(o.output))}`;
}

/**
 * Render a run, with Guard's behaviour findings (what the sandbox saw the code do that a rule
 * speaks about) right under the header line.
 */
export function renderRun(
  o: RunOutcome,
  req: RunRequest,
  store: ProjectStore,
  ref: ProjectRef,
  sessionId: string | null,
  notes: string[] = [],
): string {
  const text = renderRunBody(o, req, store, ref, sessionId);
  if (!notes.length) return text;
  const nl = text.indexOf("\n");
  const shown = notes.slice(0, 6).map((n) => `[sieve guard] behaviour ${n}`);
  if (notes.length > 6) shown.push(`[sieve guard] behaviour: ${notes.length - 6} more (sieve guard log)`);
  return `${nl === -1 ? text : text.slice(0, nl)}\n${shown.join("\n")}${nl === -1 ? "" : text.slice(nl)}`;
}

export interface Job {
  id: string;
  startedAt: number;
  req: RunRequest;
  bytes: number;
  result: string | null;
  partial: () => string;
  kill: () => void;
}

/** Background runs, polled through sieve_get(j_…). */
export class Jobs {
  private jobs = new Map<string, Job>();

  get active(): number {
    let n = 0;
    for (const j of this.jobs.values()) if (j.result === null) n++;
    return n;
  }

  start(req: RunRequest, cwd: string, finish: (o: RunOutcome) => string, sb?: SandboxContext): Job {
    const id = jobId();
    const job: Job = {
      id,
      startedAt: Date.now(),
      req,
      bytes: 0,
      result: null,
      partial: () => "",
      kill: () => {},
    };
    const run = execute(
      req,
      cwd,
      (n) => {
        job.bytes = n;
      },
      sb,
    );
    job.partial = run.partial;
    job.kill = run.kill;
    this.jobs.set(id, job);
    void run.done.then((o) => {
      job.result = finish(o);
    });
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  killAll(): void {
    for (const j of this.jobs.values()) if (j.result === null) j.kill();
  }
}
