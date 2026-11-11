import { basename } from "node:path";
import { analyze, type FileOp, isSecretPath, resolvePath } from "./facts.ts";
import { type Action, decide, type EvalContext, type Match, type SourceRule, type Subject } from "./rules.ts";

/**
 * Behaviour checks (slice 7): "inside the sandbox, record the files opened, hosts contacted and
 * processes started, and apply the same rules to them." On macOS the sandbox reports each
 * operation a profile clause asks it to report, and refuses the ones a clause denies. So:
 *
 *  1. `compileBehaviour` turns the rules that can be expressed as a single kind of operation
 *     (a file, a program, a network endpoint) into Seatbelt clauses: a rule that denies, in
 *     enforce mode, becomes a kernel-level deny; any other deny/ask/log rule becomes a clause
 *     that reports what it matches. Rules that need the command's arguments (flags, args,
 *     push targets, capabilities, patterns) cannot be seen from the kernel and stay static.
 *  2. The daemon watches the sandbox's report stream while the run lasts.
 *  3. `evaluateObserved` turns what was seen back into rule subjects and applies the rules.
 *
 * A denied operation is blocked and logged by the kernel whatever else happens; an operation a
 * rule only asks about or logs is allowed and reported afterwards, because the kernel cannot ask.
 */

export interface Skipped {
  id: string;
  why: string;
}

export interface BehaviourClauses {
  /** `(allow … (with report))` clauses: operations to observe. */
  report: string[];
  /** `(deny …)` clauses compiled from deny rules (enforce mode only). */
  deny: string[];
  /** Which rule each clause came from, in the order of `report` then `deny`. */
  origin: Array<{ id: string; kind: "report" | "deny" }>;
  skipped: Skipped[];
}

// ------------------------------------------------------------------ SBPL text

/** A path in a profile: real characters only; anything that could end the string is refused. */
function str(p: string): string {
  for (const ch of p)
    if (ch.charCodeAt(0) < 0x20 || ch === '"' || ch === "\\")
      throw new Error(`unsupported character in ${JSON.stringify(p)}`);
  return `"${p}"`;
}

/** A glob as an anchored Seatbelt regex literal. Every character that means something is escaped. */
export function globRegex(glob: string): string {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '"' || c.charCodeAt(0) < 0x20)
      throw new Error(`unsupported character in ${JSON.stringify(glob)}`);
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        // Kernel paths are absolute, so `**/x` can be `.*/x`: it cannot match `/bin/not-x`. (An
        // optional group, `(.*/)?x`, is mishandled by the sandbox's matcher for some programs.)
        if (glob[i + 1] === "/") {
          re += ".*/";
          i++;
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const e = glob.indexOf("}", i);
      if (e === -1) re += "\\{";
      else {
        re += `(${glob
          .slice(i + 1, e)
          .split(",")
          .map((alt) =>
            [...alt].map((x) => (x === "*" ? "[^/]*" : /[.+^$()|[\]\\{}]/.test(x) ? `\\${x}` : x)).join(""),
          )
          .join("|")})`;
        i = e;
      }
    } else re += /[.+^$()|[\]\\{}]/.test(c) ? `\\${c}` : c;
  }
  return `#"^${re}$"`;
}

const reEsc = (t: string) => t.replace(/[.+^$()|[\]\\{}]/g, "\\$&");

/**
 * A regex for a file *name* glob. The sandbox's matcher silently fails to report for some
 * programs when a pattern starts with an optional group or has a wildcard right after the slash
 * (checked against the system, framework and Homebrew Pythons, Bun and the usual tools), so names
 * are compiled only into four shapes that were verified to report: an exact name, a suffix, a
 * prefix with a trailing wildcard, and a literal-wildcard-literal middle. Anything fancier falls
 * back to the generic translation.
 */
export function nameRegex(name: string): string {
  for (const ch of name)
    if (ch === '"' || ch.charCodeAt(0) < 0x20)
      throw new Error(`unsupported character in ${JSON.stringify(name)}`);
  if (!/[*?{]/.test(name)) return `#"/${reEsc(name)}$"`;
  const suffix = /^\*([^*?{]+)$/.exec(name);
  if (suffix) return `#"${reEsc(suffix[1]!)}$"`;
  const prefix = /^([^*?{]+)\*$/.exec(name);
  if (prefix) return `#"/${reEsc(prefix[1]!)}[^/]*$"`;
  const middle = /^([^*?{]+)\*([^*?{]+)$/.exec(name);
  if (middle) return `#"/${reEsc(middle[1]!)}[^/]*${reEsc(middle[2]!)}$"`;
  return globRegex(`**/${name}`);
}

/** A regex for "ends with .ext". */
export const extRegex = (ext: string) => nameRegex(`*.${ext.replace(/^\./, "")}`);

const expandHome = (p: string, home: string) =>
  p === "~"
    ? home
    : p.startsWith("~/")
      ? `${home}/${p.slice(2)}`
      : p.startsWith("$HOME/")
        ? `${home}/${p.slice(6)}`
        : p === "$HOME"
          ? home
          : p;

// ------------------------------------------------------------------ compiling a rule

type Compiled = { ops: string[]; filters: string[] } | { skip: string };

const FILE_OPS: Record<string, string[]> = {
  read: ["file-read*"],
  write: ["file-write*"],
  delete: ["file-write*"],
  chmod: ["file-write*"],
  any: ["file-read*", "file-write*"],
};

function compileFile(m: Match, home: string, cwd?: string): Compiled {
  const f = m.file;
  const dirs = (list: readonly string[]) =>
    list.map((d) => {
      const e = expandHome(d, home);
      return !e.startsWith("/") && cwd ? `${cwd}/${e}`.replace(/\/\.$/, "") : e;
    });
  const filters: string[] = [];
  if (f) {
    if (f.outside) return { skip: "an `outside` file filter cannot be expressed" };
    if (f.ops?.length === 1 && f.ops[0] === "list") return { skip: "listing a folder is not reported" };
    if (f.under)
      filters.push(
        f.under.length === 1
          ? `(subpath ${str(dirs(f.under)[0]!)})`
          : `(require-any ${dirs(f.under)
              .map((d) => `(subpath ${str(d)})`)
              .join(" ")})`,
      );
    if (f.name)
      filters.push(
        f.name.length === 1
          ? `(regex ${nameRegex(f.name[0]!)})`
          : `(require-any ${f.name.map((n) => `(regex ${nameRegex(n)})`).join(" ")})`,
      );
    if (f.ext) filters.push(`(require-any ${f.ext.map((e) => `(regex ${extRegex(e)})`).join(" ")})`);
  }
  if (m.paths)
    filters.push(
      `(require-any ${m.paths.map((p) => `(regex ${globRegex(expandHome(p, home))})`).join(" ")})`,
    );
  if (!filters.length) return { skip: "no path to match" };
  const ops = new Set<string>();
  for (const o of f?.ops ?? ["any"]) for (const x of FILE_OPS[o] ?? []) ops.add(x);
  const filter = filters.length === 1 ? filters[0]! : `(require-all ${filters.join(" ")})`;
  return { ops: [...ops], filters: [filter] };
}

/** Compile one rule's match into an operation class, or say why it cannot be. */
function compileMatch(m: Match, home: string, cwd?: string): Compiled {
  const keys = Object.keys(m).filter((k) => (m as Record<string, unknown>)[k] !== undefined);
  const fileish = keys.filter((k) => k === "file" || k === "paths");
  const prog = keys.includes("program");
  const net = keys.filter((k) => k === "port" || k === "host" || k === "cidr");
  const other = keys.filter((k) => !["file", "paths", "program", "port", "host", "cidr"].includes(k));
  if (other.length)
    return { skip: `needs the command itself (${other.join(", ")}), which the kernel does not see` };
  const classes = Number(fileish.length > 0) + Number(prog) + Number(net.length > 0);
  if (classes === 0) return { skip: "nothing to match" };
  if (classes > 1) return { skip: "mixes files, programs and the network in one rule" };
  if (fileish.length) return compileFile(m, home, cwd);
  if (prog) {
    const names = m.program as string[];
    return {
      ops: ["process-exec*"],
      filters: [`(require-any ${names.map((n) => `(regex ${nameRegex(n)})`).join(" ")})`],
    };
  }
  // network
  const filters: string[] = [];
  if (m.port) for (const p of m.port) filters.push(`(remote ip ${str(`*:${p}`)})`);
  const hosts = Array.isArray(m.host) ? m.host : [];
  if (m.host && !Array.isArray(m.host)) return { skip: "a negated host list cannot be expressed" };
  for (const h of hosts) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) filters.push(`(remote ip ${str(`${h}:*`)})`);
    else return { skip: `host name ${h} (the sandbox sees addresses, not names)` };
  }
  for (const c of m.cidr ?? []) {
    const [ip, bits] = c.split("/");
    if (bits === undefined || bits === "32") filters.push(`(remote ip ${str(`${ip}:*`)})`);
    else return { skip: `network range ${c} (only single addresses can be expressed)` };
  }
  if (m.port && (hosts.length || m.cidr?.length))
    return { skip: "a host together with a port cannot be expressed" };
  if (!filters.length) return { skip: "nothing to match" };
  return {
    ops: ["network-outbound"],
    filters: [filters.length === 1 ? filters[0]! : `(require-any ${filters.join(" ")})`],
  };
}

/**
 * The Seatbelt clauses for a policy. `cannotDeny` is set when an allow rule in the user's file
 * could override a denial: a kernel-level deny would then contradict the user's own allowance,
 * so deny rules are only reported.
 */
export function compileBehaviour(
  rules: readonly SourceRule[],
  mode: "enforce" | "monitor",
  ctx: { home: string; cwd?: string; cannotDeny?: boolean },
): BehaviourClauses {
  const out: BehaviourClauses = { report: [], deny: [], origin: [], skipped: [] };
  for (const { rule } of rules) {
    if (rule.action === "allow") continue;
    const c = compileMatch(rule.match, ctx.home, ctx.cwd);
    if ("skip" in c) {
      out.skipped.push({ id: rule.id, why: c.skip });
      continue;
    }
    const kernelDeny = rule.action === "deny" && mode === "enforce" && !ctx.cannotDeny;
    for (const op of c.ops) {
      const text = `(${kernelDeny ? "deny" : "allow"} ${op} ${c.filters.join(" ")}${kernelDeny ? "" : " (with report)"})`;
      (kernelDeny ? out.deny : out.report).push(text);
      out.origin.push({ id: rule.id, kind: kernelDeny ? "deny" : "report" });
    }
  }
  return out;
}

// ------------------------------------------------------------------ what was observed

export interface Observed {
  pid: number;
  /** Process name as the kernel reports it. */
  proc: string;
  verdict: "allow" | "deny";
  /** The sandbox operation: file-read-data, file-write-create, network-outbound, process-exec*, … */
  op: string;
  /** A path, `remote:ADDRESS:PORT`, or the program path. */
  target: string;
}

const FILE_OP: Array<[RegExp, FileOp]> = [
  [/^file-read/, "read"],
  [/^file-write-unlink$/, "delete"],
  [/^file-write-(mode|flags|owner|acl|xattr)/, "chmod"],
  [/^file-write/, "write"],
];

/** One observation as a rule subject, or null for operations rules do not speak about. */
export function subjectFor(o: Observed, ctx: { cwd?: string; home?: string }): Subject | null {
  const base = (program: string): Subject => ({
    program,
    tool: "sieve_run",
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
    raw: `${o.proc} ${o.op} ${o.target}`,
  });
  const file = FILE_OP.find(([re]) => re.test(o.op));
  if (file) {
    const s = base(o.proc);
    const path = resolvePath(o.target, { ...ctx });
    s.paths = [{ path, ops: [file[1]] }];
    s.capabilities = [
      file[1] === "read" ? "fs.read" : "fs.write",
      ...(file[1] === "read" && isSecretPath(path) ? ["secret.read"] : []),
    ];
    return s;
  }
  if (o.op === "network-outbound") {
    const m = /^remote:(.*):(\d+)$/.exec(o.target);
    const s = base(o.proc);
    // The sandbox reports loopback and wildcard targets as "*": only the port is known then.
    s.hosts = m ? [{ host: m[1] === "*" ? "localhost" : m[1]!, port: Number(m[2]) }] : [];
    s.capabilities = ["net.fetch"];
    return s;
  }
  if (o.op.startsWith("process-exec")) {
    const program = basename(o.target);
    const a = analyze(program, { ...ctx });
    const s = base(program);
    s.capabilities = a.commands[0]?.capabilities ?? [];
    return s;
  }
  return null;
}

export interface Finding {
  action: Action;
  ruleId: string;
  reason?: string;
  observed: Observed;
  /** The kernel refused it (a compiled deny) rather than only reporting it. */
  blocked: boolean;
}

/** Apply the rules to what the run did. Allowed operations no rule speaks about produce nothing. */
export function evaluateObserved(
  observed: readonly Observed[],
  rules: readonly SourceRule[],
  ctx: EvalContext,
): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const o of observed) {
    const s = subjectFor(o, ctx);
    if (!s) continue;
    const d = decide(rules, [s], { patterns: [] }, ctx);
    if (d.action === "allow" || !d.ruleId) continue;
    const key = `${d.ruleId}|${o.op}|${o.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      action: d.action,
      ruleId: d.ruleId,
      ...(d.reason ? { reason: d.reason } : {}),
      observed: o,
      blocked: o.verdict === "deny",
    });
  }
  return out;
}

/** "read /work/.env", "connected to *:8080", "started /bin/rm" */
export function describeObserved(o: Observed): string {
  if (o.op.startsWith("file-read")) return `read ${o.target}`;
  if (o.op.startsWith("file-write"))
    return `${o.op === "file-write-unlink" ? "deleted" : "wrote"} ${o.target}`;
  if (o.op === "network-outbound") return `connected to ${o.target.replace(/^remote:/, "")}`;
  if (o.op.startsWith("process-exec")) return `started ${o.target}`;
  return `${o.op} ${o.target}`;
}
