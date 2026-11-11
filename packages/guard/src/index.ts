import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { AuditLog, type AuditRow } from "./audit.ts";
import {
  type BehaviourClauses,
  compileBehaviour,
  describeObserved,
  evaluateObserved,
  type Finding,
  type Observed,
} from "./behaviour.ts";
import {
  type Analysis,
  type AnalyzeContext,
  analyze,
  type Facts,
  findHosts,
  isSecretPath,
  resolvePath,
} from "./facts.ts";
import { merged, PRESET_ORDER, type PresetName, presetRules } from "./presets.ts";
import {
  type Action,
  type Decision,
  decide,
  type EvalContext,
  type PolicyFile,
  parsePolicyFile,
  type Rule,
  type Scope,
  type Settings,
  type SourceRule,
  type Subject,
} from "./rules.ts";

export * from "./audit.ts";
export * from "./behaviour.ts";
export * from "./facts.ts";
export * from "./presets.ts";
export * from "./rules.ts";
export * from "./shell.ts";

// ------------------------------------------------------------------ events

export type ToolKind = "shell" | "read" | "edit" | "search" | "web" | "mcp" | "other";

/** A tool call about to run, as Guard sees it. */
export interface GuardEvent {
  tool: string;
  family: ToolKind;
  /** The tool's input, as the agent gave it. */
  input?: unknown;
  /** MCP server and tool, when the call is an MCP call. */
  mcp?: { server?: string; tool?: string };
  /** A sieve_run call: its code and the extra access it asks for. */
  run?: { language: string; code: string; network?: string[]; writable?: string[]; env?: string[] };
  cwd?: string;
  sessionId?: string;
  worktree?: string;
  repoRoot?: string;
  agent?: string;
}

/** A tool input as an object. Some agents send it as a JSON string; that is read, not ignored. */
const rec = (v: unknown): Record<string, unknown> | null => {
  if (typeof v === "string") {
    try {
      return rec(JSON.parse(v));
    } catch {
      return null;
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
};

const pathOf = (input: unknown): string | null => {
  const i = rec(input);
  const p = i?.file_path ?? i?.path ?? i?.filePath ?? i?.target_file ?? i?.notebook_path;
  return typeof p === "string" && p ? p : null;
};

/** Strings anywhere in a value (bounded), for finding URLs and paths in MCP inputs. */
function strings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (out.length > 200 || depth > 6) return out;
  if (typeof v === "string") out.push(v.length > 4000 ? v.slice(0, 4000) : v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out, depth + 1);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out, depth + 1);
  return out;
}

const blank = (program: string, tool: string): Subject => ({
  program,
  tool,
  args: [],
  flags: [],
  flagValues: {},
  paths: [],
  hosts: [],
  capabilities: [],
  wrappers: [],
  forcePush: false,
  forceWithLease: false,
  pushTarget: [],
  raw: "",
});

// ------------------------------------------------------------------ policy

export interface LoadedFile {
  scope: Scope;
  path: string;
  file: PolicyFile;
}

export interface Policy {
  mode: "enforce" | "monitor";
  preset: PresetName;
  settings: Required<Settings>;
  rules: SourceRule[];
  verbose: boolean;
  files: LoadedFile[];
  /** Files that exist but could not be used (and why). The preset still applies. */
  errors: Array<{ path: string; error: string }>;
}

export interface GuardOptions {
  /** SIEVE_HOME: holds guard.toml and the audit log. */
  sieveHome: string;
  home?: string;
  now?: () => number;
  /** For tests: where scripts are read from. */
  readFile?: (path: string) => string | null;
}

export interface GuardResult {
  decision: Decision;
  mode: "enforce" | "monitor";
  /** What to do now: deny/ask only when enforcing; otherwise allow (a log row says what would have happened). */
  action: Action;
  /** Short text for the agent when blocked or asked. */
  message?: string;
  analysis?: Analysis;
}

const textFile = (p: string): string | null => {
  try {
    if (!existsSync(p) || statSync(p).size > 128 * 1024) return null;
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

export function currentBranch(cwd: string | undefined): string | null {
  if (!cwd) return null;
  try {
    // symbolic-ref works before the first commit, where rev-parse HEAD does not.
    return (
      execFileSync("git", ["-C", cwd, "symbolic-ref", "--short", "HEAD"], {
        encoding: "utf8",
        timeout: 150,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

interface PolicyState {
  mode: "enforce" | "monitor";
  preset: PresetName;
  lists: { approved_registries: string[]; allowed_hosts: string[]; allowed_mcp: string[] };
  rules: Record<string, Action>;
}

const STRICT: Record<Action, number> = { deny: 3, ask: 2, allow: 1, log: 0 };

/** What changed between two recorded user policies, and which way each change points. */
export function diffPolicy(
  a: PolicyState,
  b: PolicyState,
): { loosened: string[]; tightened: string[]; changed: string[] } {
  const loosened: string[] = [];
  const tightened: string[] = [];
  const changed: string[] = [];
  if (a.mode !== b.mode) (b.mode === "monitor" ? loosened : tightened).push(`mode ${a.mode} → ${b.mode}`);
  if (a.preset !== b.preset)
    (PRESET_ORDER.indexOf(b.preset) < PRESET_ORDER.indexOf(a.preset) ? loosened : tightened).push(
      `preset ${a.preset} → ${b.preset}`,
    );
  for (const k of ["approved_registries", "allowed_hosts", "allowed_mcp"] as const) {
    const added = b.lists[k].filter((x) => !a.lists[k].includes(x));
    const removed = a.lists[k].filter((x) => !b.lists[k].includes(x));
    if (added.length) loosened.push(`${k} gained ${added.join(", ")}`);
    if (removed.length) tightened.push(`${k} lost ${removed.join(", ")}`);
  }
  for (const [id, act] of Object.entries(b.rules)) {
    const was = a.rules[id];
    if (was === undefined)
      (act === "allow" ? loosened : act === "log" ? changed : tightened).push(`rule ${id} (${act}) added`);
    else if (was !== act)
      (STRICT[act] < STRICT[was] && STRICT[was] >= 2
        ? loosened
        : STRICT[act] > STRICT[was]
          ? tightened
          : changed
      ).push(`rule ${id} ${was} → ${act}`);
  }
  for (const [id, was] of Object.entries(a.rules))
    if (!(id in b.rules)) (STRICT[was] >= 2 ? loosened : changed).push(`rule ${id} (${was}) removed`);
  return { loosened, tightened, changed };
}

export class Guard {
  readonly audit: AuditLog;
  private home: string;
  private cache = new Map<string, { sig: string; policy: Policy }>();
  private now: () => number;
  private readFile: (path: string) => string | null;
  private reported = new Set<string>();
  /** The last version of each policy file that parsed, kept in force if a later edit does not. */
  private lastGood = new Map<string, PolicyFile>();

  constructor(readonly opts: GuardOptions) {
    this.home = opts.home ?? homedir();
    this.audit = new AuditLog(join(opts.sieveHome, "guard", "audit.jsonl"));
    this.now = opts.now ?? Date.now;
    this.readFile = opts.readFile ?? textFile;
  }

  userFile = () => join(this.opts.sieveHome, "guard.toml");

  private fileSig(paths: string[]): string {
    return paths
      .map((p) => {
        try {
          const st = statSync(p);
          return `${p}:${st.size}:${st.mtimeMs}`;
        } catch {
          return `${p}:-`;
        }
      })
      .join("|");
  }

  /** The effective policy for a repo and worktree (cached until a file changes). */
  policy(repoRoot?: string, worktree?: string): Policy {
    const paths: Array<[Scope, string]> = [["user", this.userFile()]];
    if (repoRoot) paths.push(["repo", join(repoRoot, ".sieve", "guard.toml")]);
    if (worktree) paths.push(["worktree", join(worktree, ".sieve", "guard.local.toml")]);
    const key = paths.map((p) => p[1]).join("|");
    const sig = this.fileSig(paths.map((p) => p[1]));
    const hit = this.cache.get(key);
    if (hit?.sig === sig) return hit.policy;
    const policy = this.build(paths);
    this.cache.set(key, { sig, policy });
    // A policy file that cannot be used is reported once per change, not silently dropped.
    for (const e of policy.errors) {
      const k = `${e.path}|${sig}`;
      if (!this.reported.has(k)) {
        this.reported.add(k);
        this.audit.append({ at: this.now(), decision: "policy", note: `ignored ${e.path}: ${e.error}` });
      }
    }
    return policy;
  }

  private build(paths: Array<[Scope, string]>): Policy {
    const files: LoadedFile[] = [];
    const errors: Policy["errors"] = [];
    for (const [scope, path] of paths) {
      if (!existsSync(path)) continue;
      // A file that stops parsing must not quietly drop the policy it used to carry (a typo in
      // `mode = "enforce"` would otherwise switch enforcement off): the last good version stays.
      const keep = (error: string) => {
        const good = this.lastGood.get(path);
        if (good) files.push({ scope, path, file: good });
        errors.push({
          path,
          error: good ? `${error} (the last version that worked is still in force)` : error,
        });
      };
      try {
        const parsed = parsePolicyFile(parse(readFileSync(path, "utf8")));
        if (parsed.ok) {
          files.push({ scope, path, file: parsed.file });
          this.lastGood.set(path, parsed.file);
        } else keep(parsed.error);
      } catch (e) {
        keep((e as Error).message);
      }
    }
    this.trackUserPolicy(files, errors);
    const user = files.find((f) => f.scope === "user")?.file;
    // Tightening settings: every scope adds. Loosening settings: only the user file counts.
    const tighten = (k: "production" | "protected_branches") => ({
      [k]: files.flatMap((f) => f.file.settings?.[k] ?? []),
    });
    const loosen = (k: "approved_registries" | "allowed_hosts" | "allowed_mcp") => ({
      [k]: user?.settings?.[k] ?? [],
    });
    const settings = merged({
      ...tighten("production"),
      ...tighten("protected_branches"),
      ...loosen("approved_registries"),
      ...loosen("allowed_hosts"),
      ...loosen("allowed_mcp"),
    } as Settings);
    // The preset can be raised by a repo (observe < balanced < locked) but only the user can lower it.
    let preset: PresetName = user?.preset ?? "balanced";
    for (const f of files)
      if (
        f.scope !== "user" &&
        f.file.preset &&
        PRESET_ORDER.indexOf(f.file.preset) > PRESET_ORDER.indexOf(preset)
      )
        preset = f.file.preset;
    // Mode: the user's choice wins; without one the default is enforce (ADR 0010). A repo cannot lower it.
    const mode = user?.mode ?? "enforce";
    const rules: SourceRule[] = presetRules(preset, settings).map((rule) => ({
      rule,
      scope: "preset" as const,
    }));
    for (const f of files)
      for (const rule of f.file.rule ?? []) rules.push({ rule, scope: f.scope, file: f.path });
    return {
      mode,
      preset,
      settings,
      rules,
      verbose: files.some((f) => f.file.audit?.verbose === true && f.scope === "user"),
      files,
      errors,
    };
  }

  // ---------------------------------------------------------------- policy changes

  private stateFile = () => join(this.opts.sieveHome, "guard", "policy-state.json");
  private reasonFile = () => join(this.opts.sieveHome, "guard", "policy-reason.txt");

  /** Record why the user's policy is about to change (the CLI does this before it edits the file). */
  noteReason(reason: string): void {
    mkdirSync(join(this.opts.sieveHome, "guard"), { recursive: true, mode: 0o700 });
    writeFileSync(this.reasonFile(), reason, { mode: 0o600 });
  }

  /**
   * Compare the user's policy with the last one recorded. A change that loosens it (monitor
   * instead of enforce, a lower preset, an allow rule, a longer allowlist, a deny rule removed)
   * is written to the audit log with its reason; without one it is logged as "policy-loosened"
   * and shown by `sieve status`. The first sight of a policy is recorded as a baseline.
   */
  private trackUserPolicy(files: LoadedFile[], errors: Policy["errors"]): void {
    const userPath = this.userFile();
    const user = files.find((f) => f.scope === "user")?.file;
    // The user's file exists but never parsed: nothing to compare yet (it is reported as an error).
    if (!user && errors.some((e) => e.path === userPath)) return;
    const now: PolicyState = {
      mode: user?.mode ?? "enforce",
      preset: user?.preset ?? "balanced",
      lists: {
        approved_registries: [...(user?.settings?.approved_registries ?? [])].sort(),
        allowed_hosts: [...(user?.settings?.allowed_hosts ?? [])].sort(),
        allowed_mcp: [...(user?.settings?.allowed_mcp ?? [])].sort(),
      },
      rules: Object.fromEntries((user?.rule ?? []).map((r) => [r.id, r.action])),
    };
    let old: PolicyState | null = null;
    try {
      old = JSON.parse(readFileSync(this.stateFile(), "utf8")) as PolicyState;
    } catch {}
    const save = () => {
      mkdirSync(join(this.opts.sieveHome, "guard"), { recursive: true, mode: 0o700 });
      writeFileSync(this.stateFile(), JSON.stringify(now), { mode: 0o600 });
    };
    if (!old) {
      save();
      try {
        this.audit.append({
          at: this.now(),
          decision: "policy",
          mode: now.mode,
          note: `baseline: mode ${now.mode}, preset ${now.preset}, ${Object.keys(now.rules).length} rules of your own`,
        });
      } catch {}
      return;
    }
    const d = diffPolicy(old, now);
    if (!d.loosened.length && !d.tightened.length && !d.changed.length) return;
    let pending = "";
    try {
      pending = readFileSync(this.reasonFile(), "utf8").trim();
      rmSync(this.reasonFile(), { force: true });
    } catch {}
    const reason = (user?.reason ?? "").trim() || pending;
    const parts = [
      ...(d.loosened.length ? [`loosened: ${d.loosened.join("; ")}`] : []),
      ...(d.tightened.length ? [`tightened: ${d.tightened.join("; ")}`] : []),
      ...d.changed.map((c) => `changed: ${c}`),
      ...(d.loosened.length ? [`reason: ${reason || "none given"}`] : reason ? [`reason: ${reason}`] : []),
    ];
    try {
      this.audit.append({
        at: this.now(),
        decision: d.loosened.length && !reason ? "policy-loosened" : "policy",
        mode: now.mode,
        note: parts.join(". "),
      });
    } catch {}
    save();
  }

  // ---------------------------------------------------------------- events → subjects

  subjectsFor(e: GuardEvent): { subjects: Subject[]; analysis: Analysis } {
    const actx: AnalyzeContext = {
      ...(e.cwd ? { cwd: e.cwd } : {}),
      home: this.home,
      readFile: this.readFile,
    };
    const empty: Analysis = { commands: [], patterns: [], truncated: false };
    const tag = (f: Facts): Subject => ({ ...f, tool: e.tool });
    if (e.family === "shell") {
      const command = rec(e.input)?.command;
      if (typeof command !== "string") return { subjects: [], analysis: empty };
      const a = analyze(command, actx);
      return { subjects: a.commands.map(tag), analysis: a };
    }
    if (e.run) {
      const subjects: Subject[] = [];
      let analysis = empty;
      if (/^(shell|sh|bash|zsh)$/i.test(e.run.language)) {
        analysis = analyze(e.run.code, actx);
        subjects.push(...analysis.commands.map(tag));
      } else {
        const s = blank(e.run.language.toLowerCase(), e.tool);
        s.raw = e.run.code.slice(0, 200);
        s.hosts = findHosts([e.run.code], "");
        for (const m of e.run.code.matchAll(/["'`]((?:~|\$HOME|\/)[A-Za-z0-9._\-/~$]{2,})["'`]/g))
          s.paths.push({ path: resolvePath(m[1]!, actx), ops: ["any"] });
        s.capabilities = [
          ...(s.hosts.length ? ["net.fetch"] : []),
          ...(s.paths.length ? ["fs.read"] : []),
          ...(s.paths.some((p) => isSecretPath(p.path)) ? ["secret.read"] : []),
        ];
        subjects.push(s);
      }
      const g = blank("sieve_run", e.tool);
      g.hosts = (e.run.network ?? []).map((h) => ({
        host: h
          .replace(/^[a-z]+:\/\//i, "")
          .replace(/[:/].*$/, "")
          .toLowerCase(),
      }));
      g.paths = (e.run.writable ?? []).map((w) => ({ path: resolvePath(w, actx), ops: ["write" as const] }));
      g.flagValues = e.run.env?.length ? { env: e.run.env.join(",") } : {};
      g.capabilities = [...(g.hosts.length ? ["net.fetch"] : []), ...(g.paths.length ? ["fs.write"] : [])];
      if (g.hosts.length || g.paths.length || e.run.env?.length) subjects.push(g);
      return { subjects, analysis };
    }
    if (e.family === "read" || e.family === "edit" || (e.family === "search" && pathOf(e.input))) {
      const p = pathOf(e.input);
      if (!p) return { subjects: [], analysis: empty };
      const s = blank(e.tool.toLowerCase(), e.tool);
      const path = resolvePath(p, actx);
      const op = e.family === "edit" ? "write" : "read";
      s.paths = [{ path, ops: [op] }];
      s.capabilities = [
        op === "read" ? "fs.read" : "fs.write",
        ...(op === "read" && isSecretPath(path) ? ["secret.read"] : []),
      ];
      return { subjects: [s], analysis: empty };
    }
    if (e.family === "web") {
      const s = blank(e.tool.toLowerCase(), e.tool);
      s.hosts = findHosts(strings(e.input), "");
      s.capabilities = ["net.fetch"];
      return { subjects: [s], analysis: empty };
    }
    if (e.family === "mcp" && e.mcp?.server !== "sieve") {
      const s = blank("mcp", e.tool);
      s.mcp = e.mcp ?? {};
      const all = strings(e.input);
      s.hosts = findHosts(all, "");
      for (const str of all)
        if (/^(~|\$HOME|\/)[^\s]{2,}$/.test(str))
          s.paths.push({ path: resolvePath(str, actx), ops: ["any"] });
      s.capabilities = [
        "mcp.call",
        ...(s.hosts.length ? ["net.fetch"] : []),
        ...(s.paths.some((p) => isSecretPath(p.path)) ? ["secret.read"] : []),
      ];
      return { subjects: [s], analysis: empty };
    }
    return { subjects: [], analysis: empty };
  }

  // ---------------------------------------------------------------- evaluate

  /** Decide on a tool call and record what needs recording. Never throws. */
  evaluate(e: GuardEvent, policy = this.policy(e.repoRoot, e.worktree), record = true): GuardResult {
    const { subjects, analysis } = this.subjectsFor(e);
    const ctx: EvalContext = {
      ...(e.cwd ? { cwd: e.cwd } : {}),
      ...(e.worktree ? { worktree: e.worktree } : {}),
      home: this.home,
      production: policy.settings.production,
      currentBranch: () => currentBranch(e.cwd),
    };
    const decision = decide(policy.rules, subjects, analysis, ctx);
    const blocking = decision.action === "deny" || decision.action === "ask";
    const enforced = blocking && policy.mode === "enforce";
    if (record && decision.action !== "allow") {
      const row: AuditRow = {
        at: this.now(),
        decision: blocking && !enforced ? `would-${decision.action}` : decision.action,
        ...(decision.ruleId ? { rule: decision.ruleId } : {}),
        ...(decision.scope ? { scope: decision.scope } : {}),
        tool: e.tool,
        ...(decision.program ? { program: decision.program } : {}),
        ...(decision.host ? { host: decision.host } : {}),
        ...(decision.path ? { path: decision.path } : {}),
        ...(e.sessionId ? { session: e.sessionId } : {}),
        ...(e.worktree ? { project: e.worktree } : {}),
        ...(e.agent ? { agent: e.agent } : {}),
        mode: policy.mode,
        ...(policy.verbose && e.family === "shell"
          ? { command: String(rec(e.input)?.command ?? "").slice(0, 500) }
          : {}),
      };
      try {
        this.audit.append(row);
      } catch {}
    }
    const action: Action = enforced ? decision.action : decision.action === "log" ? "log" : "allow";
    const verb = decision.action === "ask" ? "needs your approval" : "was blocked";
    return {
      decision,
      mode: policy.mode,
      action,
      ...(enforced
        ? {
            message: `[sieve guard] This ${verb} by rule ${decision.ruleId}${decision.reason ? `: ${decision.reason}` : ""}.${decision.alternative ? ` Safer: ${decision.alternative}` : ""}`,
          }
        : {}),
      analysis,
    };
  }

  // ---------------------------------------------------------------- behaviour

  /**
   * The sandbox clauses for a run in this repo: deny rules that can be expressed as a kernel
   * operation become denies (in enforce mode); the rest that can be expressed are reported.
   */
  behaviourClauses(e: Pick<GuardEvent, "repoRoot" | "worktree" | "cwd">): BehaviourClauses {
    const policy = this.policy(e.repoRoot, e.worktree);
    // A user allow rule may exempt something a deny rule covers; a kernel deny would contradict it.
    const cannotDeny = policy.rules.some((r) => r.scope === "user" && r.rule.action === "allow");
    return compileBehaviour(policy.rules, policy.mode, {
      home: this.home,
      ...(e.cwd ? { cwd: e.cwd } : {}),
      cannotDeny,
    });
  }

  /** Apply the rules to what a run did, record the findings, and return them with a receipt line each. */
  judgeObserved(observed: readonly Observed[], e: GuardEvent): { findings: Finding[]; lines: string[] } {
    const policy = this.policy(e.repoRoot, e.worktree);
    const findings = evaluateObserved(observed, policy.rules, {
      ...(e.cwd ? { cwd: e.cwd } : {}),
      ...(e.worktree ? { worktree: e.worktree } : {}),
      home: this.home,
      production: policy.settings.production,
    });
    const lines: string[] = [];
    for (const f of findings) {
      const enforcing = policy.mode === "enforce";
      const what = describeObserved(f.observed);
      const status = f.blocked
        ? "blocked"
        : f.action === "log"
          ? "logged"
          : enforcing
            ? "flagged"
            : `would be ${f.action === "ask" ? "asked about" : "blocked"}`;
      lines.push(`${status}: ${what} (${f.ruleId}${f.reason ? `: ${f.reason}` : ""})`);
      try {
        this.audit.append({
          at: this.now(),
          decision: f.blocked
            ? "deny"
            : f.action === "log"
              ? "log"
              : enforcing
                ? "flagged"
                : `would-${f.action}`,
          rule: f.ruleId,
          tool: "sieve_run:behaviour",
          program: f.observed.proc,
          ...(f.observed.op === "network-outbound"
            ? { host: f.observed.target.replace(/^remote:/, "") }
            : f.observed.op.startsWith("process-exec")
              ? {}
              : { path: f.observed.target }),
          ...(e.sessionId ? { session: e.sessionId } : {}),
          ...(e.worktree ? { project: e.worktree } : {}),
          mode: policy.mode,
        });
      } catch {}
    }
    return { findings, lines };
  }

  // ---------------------------------------------------------------- tests

  /** Run the saved tests of the given rules against a policy. Returns failures. */
  runTests(
    rules: readonly Rule[],
    policy: Policy,
    cwd = "/work/proj",
  ): {
    total: number;
    failures: Array<{ rule: string; input: string; expected: Action; got: Action; by?: string }>;
  } {
    const failures: Array<{ rule: string; input: string; expected: Action; got: Action; by?: string }> = [];
    let total = 0;
    // Tests ask what the rules say, not what the mode would do: evaluate in enforce mode, without writing audit rows.
    const p: Policy = { ...policy, mode: "enforce" };
    for (const r of rules)
      for (const t of r.test ?? []) {
        total++;
        const event: GuardEvent =
          t.command !== undefined
            ? { tool: "Bash", family: "shell", input: { command: t.command }, cwd }
            : eventFromTable(t.event ?? {}, cwd);
        const { subjects, analysis } = this.subjectsFor(event);
        const d = decide(p.rules, subjects, analysis, {
          cwd,
          home: this.home,
          production: p.settings.production,
          currentBranch: () => null,
        });
        if (d.action !== t.expect)
          failures.push({
            rule: r.id,
            input: t.command ?? JSON.stringify(t.event),
            expected: t.expect,
            got: d.action,
            ...(d.ruleId ? { by: d.ruleId } : {}),
          });
      }
    return { total, failures };
  }
}

/** `event = { tool = "Read", path = "config/.env" }` in a rule test. */
function eventFromTable(t: Record<string, unknown>, cwd: string): GuardEvent {
  const tool = String(t.tool ?? "Bash");
  const family: ToolKind = t.family
    ? (String(t.family) as ToolKind)
    : /^(read|view|cat)$/i.test(tool)
      ? "read"
      : /^(edit|write|multiedit|notebookedit)$/i.test(tool)
        ? "edit"
        : /^(webfetch|websearch)$/i.test(tool)
          ? "web"
          : t.server || /^mcp/i.test(tool)
            ? "mcp"
            : "shell";
  return {
    tool,
    family,
    input:
      family === "shell"
        ? { command: t.command }
        : { path: t.path, url: t.url, ...(typeof t.input === "object" ? (t.input as object) : {}) },
    ...(t.server || t.mcp_tool
      ? {
          mcp: {
            ...(t.server ? { server: String(t.server) } : {}),
            ...(t.mcp_tool ? { tool: String(t.mcp_tool) } : {}),
          },
        }
      : {}),
    cwd,
  };
}
