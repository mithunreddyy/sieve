import { homedir } from "node:os";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { Analysis, Facts, FileOp, HostUse } from "./facts.ts";
import { globToRegExp } from "./facts.ts";

/**
 * Guard rules (slice 7): the TOML grammar of DESIGN §7, its matchers, and the decision.
 *
 * Scopes, narrow to wide: worktree (`<worktree>/.sieve/guard.local.toml`), repo
 * (`<repo>/.sieve/guard.toml`), user (`~/.sieve/guard.toml`), then the preset. Within one scope
 * `deny` beats `ask` beats `allow` beats `log`. A repository is untrusted input, so only the
 * user scope may loosen policy: an `allow` in a repo or worktree file overrides denials from
 * repo/worktree files only, never from the user file or a preset.
 */

export type Action = "allow" | "deny" | "ask" | "log";
export type Scope = "worktree" | "repo" | "user" | "preset";

const SCOPE_RANK: Record<Scope, number> = { worktree: 0, repo: 1, user: 2, preset: 3 };

// ------------------------------------------------------------------ schema

const strs = z.union([z.string(), z.array(z.string())]).transform((v) => (Array.isArray(v) ? v : [v]));
const negatable = z.union([strs, z.object({ not: strs }).strict(), z.object({ in: strs }).strict()]);

const FileMatcher = z
  .object({
    under: strs.optional(),
    name: strs.optional(),
    ext: strs.optional(),
    outside: strs.optional(),
    ops: z.array(z.enum(["read", "write", "delete", "chmod", "list", "any"])).optional(),
  })
  .strict();

const Match = z
  .object({
    program: strs.optional(),
    subcommand: strs.optional(),
    flags: z.array(z.string()).optional(),
    any_flags: z.array(z.string()).optional(),
    flag_values: z.record(z.string(), negatable).optional(),
    args: z.array(z.string()).optional(),
    paths: z.array(z.string()).optional(),
    /** Paths the command deletes (rm operands, the source of mv, find … -delete). */
    deletes: z.array(z.string()).optional(),
    push_target: z.array(z.string()).optional(),
    force_push: z.boolean().optional(),
    capability: z.array(z.string()).optional(),
    host: negatable.optional(),
    cidr: z.array(z.string()).optional(),
    port: z.array(z.number().int()).optional(),
    pattern: z.enum(["download-and-run", "env-dump", "fork-bomb"]).optional(),
    file: FileMatcher.optional(),
    mcp_server: negatable.optional(),
    mcp_tool: negatable.optional(),
    tool: strs.optional(),
    production: z.boolean().optional(),
  })
  .strict();
export type Match = z.infer<typeof Match>;

const RuleTest = z
  .object({
    command: z.string().optional(),
    event: z.record(z.string(), z.unknown()).optional(),
    expect: z.enum(["allow", "deny", "ask", "log"]),
  })
  .strict()
  .refine((t) => (t.command === undefined) !== (t.event === undefined), {
    message: "give exactly one of command or event",
  });
export type RuleTest = z.infer<typeof RuleTest>;

const Rule = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9_.-]+$/, "ids use letters, digits, . _ -"),
    action: z.enum(["allow", "deny", "ask", "log"]),
    reason: z.string().optional(),
    alternative: z.string().optional(),
    match: Match,
    test: z.array(RuleTest).optional(),
  })
  .strict()
  .refine((r) => r.action !== "allow" || (r.reason ?? "").trim().length > 0, {
    message: "an allow rule needs a reason: it loosens the policy, and the reason goes in the audit log",
    path: ["reason"],
  });
export type Rule = z.infer<typeof Rule>;

const Settings = z
  .object({
    /** Names that mark a target as production (tightening: every scope adds). */
    production: z.array(z.string()).optional(),
    /** Branches force pushes to are blocked (tightening: every scope adds). */
    protected_branches: z.array(z.string()).optional(),
    /** Registry URLs package installs may use (loosening: user scope only). */
    approved_registries: z.array(z.string()).optional(),
    /** Hosts the `locked` preset allows the network to (loosening: user scope only). */
    allowed_hosts: z.array(z.string()).optional(),
    /** MCP servers the `locked` preset allows (loosening: user scope only). */
    allowed_mcp: z.array(z.string()).optional(),
  })
  .strict();
export type Settings = z.infer<typeof Settings>;

export const PolicyFile = z
  .object({
    mode: z.enum(["enforce", "monitor"]).optional(),
    preset: z.enum(["observe", "balanced", "locked"]).optional(),
    /** Why the policy was last changed. Recorded in the audit log when a change loosens it. */
    reason: z.string().optional(),
    settings: Settings.optional(),
    audit: z.object({ verbose: z.boolean().optional() }).strict().optional(),
    rule: z.array(Rule).optional(),
  })
  .strict();
export type PolicyFile = z.infer<typeof PolicyFile>;

export function parsePolicyFile(raw: unknown): { ok: true; file: PolicyFile } | { ok: false; error: string } {
  const r = PolicyFile.safeParse(raw);
  if (r.success) {
    const ids = new Set<string>();
    for (const rule of r.data.rule ?? []) {
      if (ids.has(rule.id)) return { ok: false, error: `duplicate rule id ${rule.id}` };
      ids.add(rule.id);
    }
    return { ok: true, file: r.data };
  }
  return {
    ok: false,
    error: r.error.issues
      .map((i) =>
        i.code === "unrecognized_keys"
          ? `${i.path.join(".") || "file"}: unknown key(s) ${(i as { keys: string[] }).keys.join(", ")}`
          : `${i.path.join(".") || "file"}: ${i.message}`,
      )
      .join("; "),
  };
}

// ------------------------------------------------------------------ subjects

/** What a rule is matched against: one effective command, or a synthetic record for a tool call. */
export interface Subject extends Facts {
  tool?: string;
  mcp?: { server?: string; tool?: string };
}

export interface EvalContext {
  cwd?: string;
  worktree?: string;
  home?: string;
  /** Names that mean production, from settings. */
  production: string[];
  /** The checked-out branch, for `git push --force` with no target. */
  currentBranch?: () => string | null;
}

export interface SourceRule {
  rule: Rule;
  scope: Scope;
  /** Settings tokens already substituted. */
  file?: string;
}

// ------------------------------------------------------------------ matchers

function expandRulePath(p: string, home: string, cwd?: string): string {
  const e =
    p === "~" || p === "$HOME"
      ? home
      : p.startsWith("~/")
        ? `${home}/${p.slice(2)}`
        : p.startsWith("$HOME/")
          ? `${home}/${p.slice(6)}`
          : p;
  return cwd && !isAbsolute(e) && !e.startsWith("*") ? resolve(cwd, e) : e;
}

const anyGlob = (globs: readonly string[], v: string) => globs.some((g) => globToRegExp(g).test(v));
const normFlag = (f: string) => (/^-[A-Za-z]{2,}$/.test(f) ? [...f.slice(1)].map((c) => `-${c}`) : [f]);

function negMatch(m: z.infer<typeof negatable>, values: readonly string[], present: boolean): boolean {
  if (!present && !values.length) return false;
  if (Array.isArray(m)) return values.some((v) => anyGlob(m, v));
  if ("not" in m) return values.some((v) => !anyGlob(m.not as string[], v));
  return values.some((v) => anyGlob(m.in as string[], v));
}

function ipv4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return null;
  return ((o[0]! << 24) >>> 0) + (o[1]! << 16) + (o[2]! << 8) + o[3]!;
}

export function inCidr(host: string, cidr: string): boolean {
  const [net, bits] = cidr.split("/");
  const ip = ipv4(host);
  const base = ipv4(net ?? "");
  if (ip === null || base === null) return false;
  const b = bits === undefined ? 32 : Number(bits);
  if (!(b >= 0 && b <= 32)) return false;
  const mask = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0;
  return (ip & mask) >>> 0 === (base & mask) >>> 0;
}

function pathMatchesFile(
  p: { path: string; ops: FileOp[] },
  f: z.infer<typeof FileMatcher>,
  c: EvalContext,
): boolean {
  const home = c.home ?? homedir();
  if (
    f.ops &&
    !(
      p.ops.some((o) => f.ops!.includes(o as never)) ||
      (p.ops.includes("any") && f.ops.some((o) => o !== "list"))
    )
  )
    return false;
  if (f.name && !anyGlob(f.name, basename(p.path))) return false;
  if (
    f.ext &&
    !f.ext.some((e) => extname(p.path).toLowerCase() === (e.startsWith(".") ? e : `.${e}`).toLowerCase())
  )
    return false;
  const under = (dirs: readonly string[]) =>
    dirs.some((d) => {
      const e = expandRulePath(d, home, c.worktree ?? c.cwd);
      return (
        p.path === e ||
        globToRegExp(`${e.replace(/\/+$/, "")}/**`).test(p.path) ||
        (e.includes("*") && globToRegExp(e).test(p.path))
      );
    });
  if (f.under && !under(f.under)) return false;
  if (f.outside && under(f.outside)) return false;
  return true;
}

function isProduction(s: Subject, names: readonly string[]): boolean {
  if (!names.length) return false;
  const tokens = new Set<string>();
  const add = (t: string | undefined) => {
    for (const x of (t ?? "").toLowerCase().split(/[^a-z0-9]+/)) if (x) tokens.add(x);
  };
  for (const a of s.args) add(a);
  for (const v of Object.values(s.flagValues)) add(v);
  add(s.remote);
  for (const h of s.hosts) add(h.host);
  return names.some((n) => tokens.has(n.toLowerCase()));
}

/** Does one subject (an effective command) satisfy every matcher of a rule? Patterns are checked on the analysis. */
export function matchSubject(
  m: Match,
  s: Subject,
  analysis: Pick<Analysis, "patterns">,
  c: EvalContext,
): boolean {
  const home = c.home ?? homedir();
  if (m.pattern !== undefined && !analysis.patterns.includes(m.pattern)) return false;
  if (m.program && !anyGlob(m.program, s.program)) return false;
  if (m.subcommand && !(s.subcommand !== undefined && anyGlob(m.subcommand, s.subcommand))) return false;
  if (m.tool && !(s.tool !== undefined && anyGlob(m.tool, s.tool))) return false;
  // A flag matches as written (-delete, --force) or, for a short cluster, letter by letter (-rf).
  const hasFlag = (f: string) => s.flags.includes(f) || normFlag(f).every((x) => s.flags.includes(x));
  if (m.flags && !m.flags.every(hasFlag)) return false;
  if (m.any_flags && !m.any_flags.some(hasFlag)) return false;
  if (m.flag_values) {
    for (const [name, want] of Object.entries(m.flag_values)) {
      const v = s.flagValues[name];
      if (v === undefined) return false;
      if (!negMatch(want, [v], true)) return false;
    }
  }
  if (m.args && !s.args.some((a) => anyGlob(m.args!, a))) return false;
  if (m.paths) {
    const globs = m.paths.map((p) => expandRulePath(p, home));
    const candidates = [
      ...s.paths.map((p) => p.path),
      ...s.args
        .filter((a) => a.includes("/") || a.startsWith("~") || a === "$HOME")
        .map((a) => expandRulePath(a, home)),
    ];
    if (!candidates.some((p) => anyGlob(globs, p))) return false;
  }
  if (m.deletes) {
    const globs = m.deletes.map((p) => expandRulePath(p, home));
    if (!s.paths.some((p) => p.ops.includes("delete") && anyGlob(globs, p.path))) return false;
  }
  if (m.force_push !== undefined && s.forcePush !== m.force_push) return false;
  if (m.push_target) {
    let targets = s.pushTarget;
    if (!targets.length && s.program === "git" && s.subcommand === "push") {
      const b = c.currentBranch?.();
      if (b) targets = [b];
    }
    if (!targets.some((t) => anyGlob(m.push_target!, t))) return false;
  }
  if (m.capability && !m.capability.some((cap) => s.capabilities.includes(cap))) return false;
  if (
    m.host &&
    !negMatch(
      m.host,
      s.hosts.map((h: HostUse) => h.host),
      s.hosts.length > 0,
    )
  )
    return false;
  if (m.cidr && !s.hosts.some((h) => m.cidr!.some((r) => inCidr(h.host, r)))) return false;
  if (m.port && !s.hosts.some((h) => h.port !== undefined && m.port!.includes(h.port))) return false;
  if (m.file && !s.paths.some((p) => pathMatchesFile(p, m.file!, c))) return false;
  if (m.mcp_server && !negMatch(m.mcp_server, s.mcp?.server ? [s.mcp.server] : [], s.mcp !== undefined))
    return false;
  if (m.mcp_tool && !negMatch(m.mcp_tool, s.mcp?.tool ? [s.mcp.tool] : [], s.mcp !== undefined)) return false;
  if (m.production !== undefined && isProduction(s, c.production) !== m.production) return false;
  return true;
}

// ------------------------------------------------------------------ decision

export interface Hit {
  rule: Rule;
  scope: Scope;
  subject: Subject;
}

export interface Decision {
  action: Action;
  ruleId?: string;
  reason?: string;
  alternative?: string;
  scope?: Scope;
  /** Every rule that matched (for the audit trail and `guard check`). */
  matched: Array<{ id: string; action: Action; scope: Scope }>;
  /** The subject that triggered the deciding rule (program, host, path, for the audit row). */
  program?: string;
  host?: string;
  path?: string;
}

const RANK: Record<Action, number> = { deny: 3, ask: 2, allow: 1, log: 0 };

/** Which scope may loosen (allow over) a deny/ask from which scope. */
function overrides(allow: Scope, blocked: Scope): boolean {
  if (allow === "user") return true;
  if (allow === "preset") return false;
  // repo/worktree files are untrusted: they can only override each other.
  return (blocked === "repo" || blocked === "worktree") && SCOPE_RANK[blocked] >= SCOPE_RANK[allow];
}

export function decide(
  rules: readonly SourceRule[],
  subjects: readonly Subject[],
  analysis: Pick<Analysis, "patterns">,
  c: EvalContext,
): Decision {
  const hits: Hit[] = [];
  const seen = new Set<string>();
  for (const sr of rules) {
    for (const s of subjects.length ? subjects : [EMPTY]) {
      if (!matchSubject(sr.rule.match, s, analysis, c)) continue;
      const key = `${sr.scope}|${sr.rule.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ rule: sr.rule, scope: sr.scope, subject: s });
    }
  }
  const matched = hits.map((h) => ({ id: h.rule.id, action: h.rule.action, scope: h.scope }));
  const blockers = hits.filter((h) => h.rule.action === "deny" || h.rule.action === "ask");
  const allows = hits.filter((h) => h.rule.action === "allow");
  const standing = blockers.filter((b) => !allows.some((a) => overrides(a.scope, b.scope)));
  const pick = (hs: Hit[]): Hit | undefined =>
    [...hs].sort(
      (a, b) => RANK[b.rule.action] - RANK[a.rule.action] || SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope],
    )[0];
  const win = pick(standing) ?? pick(hits.filter((h) => h.rule.action === "log")) ?? pick(allows);
  if (!win) return { action: "allow", matched };
  return {
    action: standing.length || win.rule.action === "log" ? win.rule.action : "allow",
    ruleId: win.rule.id,
    ...(win.rule.reason ? { reason: win.rule.reason } : {}),
    ...(win.rule.alternative ? { alternative: win.rule.alternative } : {}),
    scope: win.scope,
    matched,
    program: win.subject.program,
    ...(win.subject.hosts[0] ? { host: win.subject.hosts[0].host } : {}),
    ...(win.subject.paths[0] ? { path: win.subject.paths[0].path } : {}),
  };
}

const EMPTY: Subject = {
  program: "",
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
};
