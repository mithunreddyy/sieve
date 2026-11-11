import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/**
 * OS isolation for `sieve_run` (slice 6). A policy says what the code may touch; `wrap` turns
 * a command line into one that runs inside the platform's sandbox, or says plainly that none
 * is available. Nothing here claims more than it enforces: `describe` reports exactly the
 * boundary in force, and that string goes into every run receipt.
 *
 * Enforced where a sandbox exists (macOS Seatbelt, Linux bubblewrap):
 *  - writes only to the project, a per-run scratch folder, and explicitly granted paths;
 *  - no network (all or nothing: neither backend can filter by host name);
 *  - credential folders unreadable;
 *  - an environment allowlist (API keys and tokens removed unless the call asks for them).
 * Not enforced: memory limits (RLIMIT_AS breaks JavaScriptCore on macOS), process counts.
 * Windows has no backend yet.
 */

export type SandboxKind = "seatbelt" | "bwrap" | "landlock" | "none";

export interface Availability {
  kind: SandboxKind;
  /** Why there is no sandbox, or what was found. */
  detail: string;
}

export interface Policy {
  /** Writable project folders (the worktree, and the git common dir's root for linked worktrees). */
  project: string[];
  /** Per-run scratch folder: writable, and TMPDIR points into it. */
  scratch: string;
  /** Extra writable paths granted by the call. */
  writable: string[];
  /** Allow the network. Host lists are recorded, not filtered. */
  network: boolean;
  networkHosts: string[];
  /** Extra environment variable names granted by the call. */
  env: string[];
  /** Folders and files the code may not read. */
  denyRead: string[];
  /** Extra Seatbelt clauses that make the sandbox report operations (compiled from Guard's rules). */
  reportClauses?: string[];
  /** Extra Seatbelt clauses that refuse operations (compiled from Guard's deny rules). */
  denyClauses?: string[];
}

export interface Wrapped {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  /** What is in force, for the receipt. */
  level: Level;
}

export interface Level {
  kind: SandboxKind;
  /** Set when kind is "none": why. */
  reason?: string;
  writes: string;
  network: string;
  env: string;
  reads: string;
  limits: string;
}

/** Environment variables every run gets; anything else needs a grant. */
export const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TERM",
  "TZ",
  "NO_COLOR",
  "CI",
  "COLORTERM",
  "SYSTEMROOT",
  "SIEVE_FILE",
];

/** Where credentials live. Reads are denied by default (relative to the home folder). */
export const CREDENTIAL_PATHS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".azure",
  ".kube",
  ".config/gcloud",
  ".config/gh",
  ".docker/config.json",
  ".npmrc",
  ".netrc",
  ".git-credentials",
  ".pypirc",
  ".claude/.credentials.json",
  ".codex/auth.json",
  ".gemini/oauth_creds.json",
  ".sieve",
  "Library/Keychains",
];

export function credentialPaths(home = homedir()): string[] {
  return CREDENTIAL_PATHS.map((p) => join(home, p));
}

// ------------------------------------------------------------------ detection

let cached: Availability | null = null;

/** The helper binary, only when the user opted in with SIEVE_SANDBOX_HELPER=1. */
export function landlockHelper(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.SIEVE_SANDBOX_HELPER !== "1") return null;
  const p = env.SIEVE_SANDBOX_HELPER_BIN || join(dirname(process.execPath), "sieve-sandbox-linux");
  return existsSync(p) ? p : null;
}

/** System folders a sandboxed program may read under Landlock. The home folder is deliberately absent. */
export const LANDLOCK_READ = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/etc",
  "/opt",
  "/proc",
  "/sys",
  "/dev",
  "/var/lib",
];

/** Arguments for the Landlock helper (pure). Landlock only adds access, so credentials are protected by leaving the home folder out. */
export function landlockArgs(
  p: Policy,
  argv: string[],
  exists: (path: string) => boolean = existsSync,
): string[] {
  const a: string[] = [];
  for (const d of LANDLOCK_READ) if (exists(d)) a.push("--ro", d);
  for (const w of [...p.project, p.scratch, ...p.writable]) a.push("--rw", w);
  if (!p.network) a.push("--no-net");
  a.push("--", ...argv);
  return a;
}

function probe(): Availability {
  if (process.platform === "darwin") {
    const r = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (r.status === 0) return { kind: "seatbelt", detail: "macOS sandbox-exec" };
    return {
      kind: "none",
      detail: `sandbox-exec is not usable: ${(r.stderr || r.error?.message || "failed").trim().slice(0, 120)}`,
    };
  }
  if (process.platform === "linux") {
    const r = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-net", "/bin/true"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (r.status === 0) return { kind: "bwrap", detail: "bubblewrap" };
    const why = r.error
      ? "bwrap (bubblewrap) is not installed"
      : `bwrap cannot create a sandbox here: ${r.stderr.trim().slice(0, 120)}`;
    // The Landlock/seccomp helper is opt-in: it has never been run on Linux by this project.
    const h = landlockHelper();
    if (h) {
      const t = spawnSync(h, ["--ro", "/usr", "--", "/bin/true"], { encoding: "utf8", timeout: 5000 });
      if (t.status === 0) return { kind: "landlock", detail: `Landlock + seccomp helper (${h}); ${why}` };
      return {
        kind: "none",
        detail: `${why}; the Landlock helper did not start: ${(t.stderr || t.error?.message || "failed").trim().slice(0, 100)}`,
      };
    }
    return { kind: "none", detail: why };
  }
  return { kind: "none", detail: `no sandbox backend for ${process.platform} yet` };
}

/** What this machine can do (probed once per process). */
export function detect(refresh = false): Availability {
  if (!cached || refresh) cached = probe();
  return cached;
}

// ------------------------------------------------------------------ grants

export class GrantError extends Error {}

const SYSTEM_DIRS = [
  "/",
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/System",
  "/Library",
  "/private/etc",
  "/var",
  "/opt",
  "/dev",
];

/** The real path of a path that may not exist yet (its nearest existing parent, resolved). */
export function realish(p: string): string {
  const abs = resolve(p);
  let cur = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail.reverse());
    } catch {
      const up = resolve(cur, "..");
      if (up === cur) return abs;
      tail.push(basename(cur));
      cur = up;
    }
  }
}

/** Sanity limits on what a call may ask to write; Guard (slice 7) will apply rules on top. */
export function checkWritable(path: string, home = homedir()): string {
  const real = realish(path);
  const h = realish(home);
  if (real === h) throw new GrantError(`refusing to make your whole home folder writable (${path})`);
  for (const d of SYSTEM_DIRS)
    if (
      real === d ||
      (d !== "/" &&
        real.startsWith(`${d}/`) &&
        !real.startsWith("/var/folders/") &&
        !real.startsWith("/private/var/folders/"))
    )
      throw new GrantError(`refusing to make a system folder writable (${path})`);
  for (const c of credentialPaths(home).map(realish))
    if (real === c || real.startsWith(`${c}/`) || c.startsWith(`${real}/`))
      throw new GrantError(`refusing to make a credentials location writable (${path})`);
  return real;
}

// ------------------------------------------------------------------ environment

/** The environment the code runs with: the allowlist, plus names the call asked for. */
export function filterEnv(
  base: Record<string, string | undefined>,
  grant: readonly string[] = [],
  extra: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [...ENV_ALLOWLIST, ...grant]) if (base[k] !== undefined) out[k] = base[k]!;
  return { ...out, ...extra };
}

// ------------------------------------------------------------------ Seatbelt

const sbString = (p: string) => {
  // Quotes, backslashes and control characters could end the string and add rules.
  for (const ch of p)
    if (ch.charCodeAt(0) < 0x20 || ch === '"' || ch === "\\")
      throw new GrantError(`unsupported character in path: ${JSON.stringify(p)}`);
  return `"${p}"`;
};

/** The Seatbelt profile for a policy. Later rules win, so denies come first and allows follow. */
/**
 * A clause from Guard must be one balanced `(allow …)` or `(deny …)` form on one line, so it can
 * only add a rule and never change the shape of the profile around it.
 */
export function checkClause(c: string, verb: "allow" | "deny"): string {
  if (!c.startsWith(`(${verb} `) || /[\n\r]/.test(c))
    throw new GrantError(`not a ${verb} clause: ${JSON.stringify(c.slice(0, 60))}`);
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < c.length; i++) {
    const ch = c[i]!;
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      if (--depth < 0) throw new GrantError("unbalanced clause");
      // The form that opened at the start closed before the end: a second form follows.
      if (depth === 0 && i !== c.length - 1) throw new GrantError("a clause must be a single form");
    }
  }
  if (depth !== 0 || inStr) throw new GrantError("unbalanced clause");
  return c;
}

export function seatbeltProfile(p: Policy): string {
  const lines = ["(version 1)", "(allow default)"];
  // Reporting clauses come first so the baseline denies below still win where they apply.
  for (const c of p.reportClauses ?? []) lines.push(checkClause(c, "allow"));
  if (!p.network) lines.push("(deny network*)");
  lines.push("(deny file-write*)");
  const writable = [...p.project, p.scratch, ...p.writable];
  lines.push(`(allow file-write* ${writable.map((w) => `(subpath ${sbString(w)})`).join(" ")})`);
  lines.push(
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
  );
  if (p.denyRead.length)
    lines.push(`(deny file-read* ${p.denyRead.map((d) => `(subpath ${sbString(d)})`).join(" ")})`);
  // Compiled deny rules go last: they must beat the write allowances above.
  for (const c of p.denyClauses ?? []) lines.push(checkClause(c, "deny"));
  return lines.join("\n");
}

// ------------------------------------------------------------------ bubblewrap

/** The bwrap command line for a policy (pure; the Linux backend runs it). */
export function bwrapArgs(
  p: Policy,
  argv: string[],
  cwd: string,
  exists: (path: string) => boolean = existsSync,
): string[] {
  const a = [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
  ];
  if (!p.network) a.push("--unshare-net");
  for (const d of p.denyRead)
    if (exists(d)) a.push(...(isDir(d) ? ["--tmpfs", d] : ["--ro-bind", "/dev/null", d]));
  for (const w of [...p.project, p.scratch, ...p.writable]) a.push("--bind", w, w);
  a.push("--chdir", cwd, "--", ...argv);
  return a;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ wrap

export type Mode = "auto" | "off" | "require";

const LIMITS = "cpu time = the timeout, no core dumps; memory and process counts are not limited";

function levelFor(kind: SandboxKind, p: Policy, reason?: string): Level {
  if (kind === "none")
    return {
      kind,
      ...(reason ? { reason } : {}),
      writes: "anywhere you can",
      network: "on",
      env: "everything",
      reads: "everything",
      limits: "timeout only",
    };
  const hosts = p.networkHosts.length ? `; hosts ${p.networkHosts.join(", ")} requested, not filtered` : "";
  return {
    kind,
    writes: `project${p.writable.length ? ` + ${p.writable.length} granted` : ""} + scratch only`,
    network: p.network ? `on (all hosts${hosts})` : "off",
    env: p.env.length ? `allowlist + ${p.env.join(", ")}` : "allowlist",
    reads:
      kind === "landlock"
        ? "system folders and the project only (home is closed)"
        : "credential folders denied",
    limits: LIMITS,
  };
}

/** The receipt line for a level. */
export function describe(l: Level): string {
  if (l.kind === "none")
    return `none (${l.reason ?? "no sandbox"}; code runs as you, with full file and network access)`;
  return `${l.kind} · writes: ${l.writes} · network: ${l.network} · env: ${l.env} · reads: ${l.reads} · limits: ${l.limits}`;
}

/**
 * Wrap a command line. With mode "off", or no backend in "auto", the command runs as given
 * and the level says so. With mode "require" and no backend this throws.
 */
export function wrap(
  argv: string[],
  cwd: string,
  policy: Policy,
  base: Record<string, string | undefined>,
  extraEnv: Record<string, string>,
  mode: Mode = "auto",
): Wrapped {
  const env = (sandboxed: boolean) =>
    sandboxed
      ? filterEnv(base, policy.env, {
          ...extraEnv,
          TMPDIR: policy.scratch,
          TMP: policy.scratch,
          TEMP: policy.scratch,
        })
      : ({ ...base, ...extraEnv } as Record<string, string>);
  const [cmd, ...args] = argv;
  if (mode === "off")
    return {
      cmd: cmd!,
      args,
      env: env(false),
      level: levelFor("none", policy, "sandbox turned off in config"),
    };
  const av = detect();
  if (av.kind === "none") {
    if (mode === "require") throw new GrantError(`sandbox required but unavailable: ${av.detail}`);
    return { cmd: cmd!, args, env: env(false), level: levelFor("none", policy, av.detail) };
  }
  if (av.kind === "seatbelt")
    return {
      cmd: "/usr/bin/sandbox-exec",
      args: ["-p", seatbeltProfile(policy), ...argv],
      env: env(true),
      level: levelFor("seatbelt", policy),
    };
  if (av.kind === "landlock")
    return {
      cmd: landlockHelper() as string,
      args: landlockArgs(policy, argv),
      env: env(true),
      level: levelFor("landlock", policy),
    };
  return {
    cmd: "bwrap",
    args: bwrapArgs(policy, argv, cwd),
    env: env(true),
    level: levelFor("bwrap", policy),
  };
}

export function defaultPolicy(
  project: string[],
  scratch: string,
  grants: Partial<Pick<Policy, "writable" | "network" | "networkHosts" | "env">> = {},
  home = homedir(),
): Policy {
  return {
    project: [...new Set(project.map(realish))],
    scratch: realish(scratch),
    writable: (grants.writable ?? []).map((w) => checkWritable(w, home)),
    network: grants.network ?? false,
    networkHosts: grants.networkHosts ?? [],
    env: grants.env ?? [],
    denyRead: credentialPaths(home).map(realish),
  };
}
