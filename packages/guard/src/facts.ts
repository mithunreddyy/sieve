import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { type Cmd, parseShell } from "./shell.ts";

/**
 * What a command line does, as far as it can be told without running it (slice 7). Wrappers are
 * read through (sudo, env, sh -c, xargs, find -exec, ssh, docker exec, npx, …); each *effective*
 * command gets a `Facts` record: program, subcommand, flags, paths with the operation on them,
 * hosts, capabilities, and git push details. Scripts, Makefile targets and package.json scripts
 * named on the command line are read and analysed too.
 *
 * This is static analysis of what was typed (and of the script files it points at). It does not
 * see what a program does when it runs; inside `sieve_run` the sandbox enforces that part.
 */

export type FileOp = "read" | "write" | "delete" | "chmod" | "list" | "any";

export interface PathUse {
  path: string;
  ops: FileOp[];
}

export interface HostUse {
  host: string;
  port?: number;
}

export interface Facts {
  /** Basename of the effective program (after wrappers). */
  program: string;
  subcommand?: string;
  /** Non-flag words after the program (includes the subcommand and any flag values). */
  args: string[];
  /** Flags, with short clusters expanded: `-rf` gives `-r`, `-f`. */
  flags: string[];
  flagValues: Record<string, string>;
  paths: PathUse[];
  hosts: HostUse[];
  capabilities: string[];
  wrappers: string[];
  forcePush: boolean;
  forceWithLease: boolean;
  /** Branches a `git push` writes to. */
  pushTarget: string[];
  /** Text of the command as written. */
  raw: string;
  /** Set when it runs somewhere else: "ssh:host", "docker:container", "kubectl:pod". */
  remote?: string;
  /** Set when found inside a script file: "package.json:test", "Makefile:build", "./deploy.sh". */
  source?: string;
}

export interface Analysis {
  commands: Facts[];
  /** Patterns found across commands: download-and-run, env-dump, fork-bomb. */
  patterns: string[];
  /** Analysis stopped early (depth or size limits). */
  truncated: boolean;
}

export interface AnalyzeContext {
  cwd?: string;
  home?: string;
  /** Read a text file (for scripts, Makefiles, package.json). Return null if missing. */
  readFile?: (path: string) => string | null;
}

const MAX_FACTS = 300;
const MAX_SCRIPT_DEPTH = 3;
const MAX_SCRIPT_BYTES = 128 * 1024;

// ------------------------------------------------------------------ small helpers

const base = (p: string) => basename(p.replace(/^.*\//, "/")).replace(/^$/, p);

/** Short flag clusters of letters are expanded: -rf → -r -f. Anything else is one flag. */
/** Programs whose single-dash options are whole words (find -delete), not clusters of letters. */
const SINGLE_DASH_LONG = new Set([
  "find",
  "java",
  "javac",
  "gcc",
  "g++",
  "clang",
  "clang++",
  "cc",
  "ld",
  "tcpdump",
  "nmap",
  "ffmpeg",
  "openssl",
  "xargs",
  "awk",
  "gawk",
]);

export function expandFlag(f: string, program = ""): string[] {
  if (!SINGLE_DASH_LONG.has(program) && /^-[A-Za-z]{2,}$/.test(f)) return [...f.slice(1)].map((c) => `-${c}`);
  return [f];
}

// Shell syntax, not template strings.
const BRACE_HOME = "$" + "{HOME}";

function expandHome(p: string, home: string): string {
  if (p === "~" || p === "$HOME" || p === BRACE_HOME) return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  if (p.startsWith("$HOME/")) return join(home, p.slice(6));
  if (p.startsWith(`${BRACE_HOME}/`)) return join(home, p.slice(BRACE_HOME.length + 1));
  return p;
}

/** A path with `~`, `$HOME` and relative parts resolved where that can be done without the shell. */
export function resolvePath(p: string, ctx: AnalyzeContext): string {
  const home = ctx.home ?? homedir();
  const e = expandHome(p, home);
  if (e.includes("$") || e.includes("*") || e.includes("(…)")) return e;
  if (isAbsolute(e)) return resolve(e); // collapses //, /./ and /x/../ so "/usr/.." is "/"
  return ctx.cwd ? resolve(ctx.cwd, e) : e;
}

// ------------------------------------------------------------------ wrappers

interface Unwrapped {
  /** Words of the inner command (when the wrapper just prefixes another command). */
  inner?: string[];
  /** Shell text to parse (sh -c, eval, ssh host 'cmd'). */
  script?: string;
  /** Hosts the wrapper itself talks to. */
  hosts?: string[];
  remote?: string;
  caps?: string[];
  /** The wrapper runs fetched code (npx, uvx, …): the program is a package name. */
  fetchesCode?: boolean;
}

type Wrapper = (args: string[]) => Unwrapped | null;

/** Index of the first word that is not an option, skipping the options that take a value. */
function afterOptions(
  args: string[],
  valueFlags: ReadonlySet<string> = new Set(),
  stopAtDoubleDash = true,
): number {
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a === "--") return stopAtDoubleDash ? i + 1 : i;
    if (!a.startsWith("-") || a === "-") return i;
    i += valueFlags.has(a) && !a.includes("=") ? 2 : 1;
  }
  return i;
}

const set = (...x: string[]) => new Set(x);
const prefix =
  (valueFlags: ReadonlySet<string> = new Set(), positional = 0): Wrapper =>
  (args) => {
    let i = afterOptions(args, valueFlags);
    i += positional;
    return i < args.length ? { inner: args.slice(i) } : null;
  };

const SHELLS = ["sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "csh", "tcsh"];

const shellWrapper: Wrapper = (args) => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") break;
    if (a.startsWith("--")) continue;
    if (/^-[A-Za-z]+$/.test(a) && a.includes("c"))
      return args[i + 1] !== undefined ? { script: args[i + 1]! } : null;
    if (!a.startsWith("-")) break;
    if (a === "-o" || a === "-O") i++;
  }
  return null;
};

const envWrapper: Wrapper = (args) => {
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a === "-S" || a === "--split-string")
      return args[i + 1] !== undefined ? { script: args[i + 1]! } : null;
    if (a === "-u" || a === "-C" || a === "--unset" || a === "--chdir") i += 2;
    else if (a.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) i++;
    else break;
  }
  return i < args.length ? { inner: args.slice(i) } : null;
};

const xargsWrapper: Wrapper = (args) => {
  const withValue = set(
    "-I",
    "-i",
    "-n",
    "-L",
    "-P",
    "-s",
    "-d",
    "-a",
    "-E",
    "--max-args",
    "--max-procs",
    "--delimiter",
    "--arg-file",
    "--replace",
  );
  const i = afterOptions(args, withValue);
  return i < args.length ? { inner: args.slice(i) } : null;
};

const findWrapper: Wrapper = (args) => {
  // find … -exec cmd {} ;   (-execdir, -ok, -okdir too). The command runs; the file list is data.
  for (let i = 0; i < args.length; i++)
    if (["-exec", "-execdir", "-ok", "-okdir"].includes(args[i]!)) {
      const rest: string[] = [];
      for (let j = i + 1; j < args.length && args[j] !== ";" && args[j] !== "\\;" && args[j] !== "+"; j++)
        rest.push(args[j]!);
      if (rest.length) return { inner: rest };
    }
  return null;
};

const remoteWrapper =
  (kind: string, valueFlags: ReadonlySet<string>, positional: number): Wrapper =>
  (args) => {
    const i = afterOptions(args, valueFlags);
    const target = args[i + positional - 1];
    const rest = args.slice(i + positional);
    if (positional > 0 && target === undefined) return null;
    const dd = rest[0] === "--" ? rest.slice(1) : rest;
    const out: Unwrapped = { remote: `${kind}:${target ?? ""}` };
    if (kind === "ssh") out.hosts = [(target ?? "").replace(/^.*@/, "")];
    if (dd.length) {
      if (kind === "ssh") out.script = dd.join(" ");
      else out.inner = dd;
    }
    return out;
  };

const sshOpts = set(
  "-p",
  "-i",
  "-l",
  "-o",
  "-F",
  "-J",
  "-L",
  "-R",
  "-D",
  "-b",
  "-c",
  "-E",
  "-I",
  "-m",
  "-O",
  "-S",
  "-W",
  "-w",
  "-B",
);

const runnerWrapper =
  (valueFlags: ReadonlySet<string> = new Set()): Wrapper =>
  (args) => {
    const i = afterOptions(args, valueFlags);
    return i < args.length
      ? { inner: args.slice(i), fetchesCode: true, caps: ["pkg.install", "net.fetch"] }
      : null;
  };

const dockerRun: Wrapper = (args) => {
  const sub = args[0];
  if (sub !== "run" && sub !== "exec" && sub !== "create") return null;
  const valueFlags = set(
    "-e",
    "--env",
    "-v",
    "--volume",
    "-p",
    "--publish",
    "-w",
    "--workdir",
    "-u",
    "--user",
    "--name",
    "--network",
    "--entrypoint",
    "-m",
    "--memory",
    "--cpus",
    "-l",
    "--label",
    "--mount",
    "-h",
    "--hostname",
    "--env-file",
    "--platform",
    "--add-host",
    "--restart",
    "--cap-add",
    "--cap-drop",
    "--device",
    "--gpus",
    "--ulimit",
    "--pull",
    "--rm=false",
  );
  const i = afterOptions(args.slice(1), valueFlags);
  const rest = args.slice(1 + i);
  const target = rest[0];
  if (!target) return null;
  const inner = rest.slice(1);
  return {
    remote: `docker:${target}`,
    ...(inner.length ? { inner } : {}),
    caps: sub === "exec" ? [] : ["net.fetch"],
  };
};

const kubectlWrapper: Wrapper = (args) => {
  const dd = args.indexOf("--");
  if (args[0] !== "exec" && !args.includes("exec")) return null;
  if (dd === -1) return null;
  const pod = args.slice(args.indexOf("exec") + 1).find((a) => !a.startsWith("-")) ?? "";
  const inner = args.slice(dd + 1);
  return inner.length ? { remote: `kubectl:${pod}`, inner } : null;
};

/** `pnpm dlx x`, `pnpm exec x`, `yarn dlx x`, `npm exec x`, `bun x x`. */
const pmRunner: Wrapper = (args) => {
  const sub = args[0];
  if (!sub || !["dlx", "exec", "x", "create"].includes(sub)) return null;
  const i = afterOptions(args.slice(1), set("-p", "--package"));
  const rest = args.slice(1 + i);
  return rest.length
    ? { inner: rest, fetchesCode: sub !== "exec", caps: sub === "exec" ? [] : ["pkg.install", "net.fetch"] }
    : null;
};

export const WRAPPERS: Record<string, Wrapper> = {
  // privilege and identity
  sudo: prefix(
    set(
      "-u",
      "-g",
      "-h",
      "-p",
      "-C",
      "-D",
      "-R",
      "-T",
      "-U",
      "-r",
      "-t",
      "--user",
      "--group",
      "--host",
      "--prompt",
      "--chdir",
    ),
  ),
  doas: prefix(set("-u", "-C")),
  pkexec: prefix(set("--user")),
  su: (a) => {
    const c = a.indexOf("-c");
    return c !== -1 && a[c + 1] ? { script: a[c + 1]! } : null;
  },
  runuser: (a) => {
    const dd = a.indexOf("--");
    if (dd !== -1) return { inner: a.slice(dd + 1) };
    const c = a.findIndex((x) => x === "-c" || x === "--command");
    return c !== -1 && a[c + 1] ? { script: a[c + 1]! } : null;
  },
  gosu: prefix(new Set(), 1),
  sg: (a) => (a[0] && a[1] ? { script: a.slice(1).join(" ") } : null),
  // environment and process control
  env: envWrapper,
  nohup: prefix(),
  nice: prefix(set("-n", "--adjustment")),
  ionice: prefix(set("-c", "-n", "-p", "-P", "-u")),
  time: prefix(set("-o", "-f", "--format", "--output")),
  timeout: prefix(set("-s", "-k", "--signal", "--kill-after"), 1),
  stdbuf: prefix(set("-i", "-o", "-e")),
  taskset: prefix(new Set(), 1),
  chrt: prefix(set("-p"), 1),
  command: prefix(set()),
  builtin: prefix(),
  exec: prefix(set("-a")),
  setsid: prefix(),
  unbuffer: prefix(),
  caffeinate: prefix(set("-t", "-w")),
  chroot: prefix(new Set(), 1),
  flock: prefix(set("-w", "-E"), 1),
  watch: prefix(set("-n", "-d", "--interval")),
  strace: prefix(set("-o", "-p", "-e", "-s", "-u", "-E")),
  ltrace: prefix(set("-o", "-p", "-e", "-s")),
  nsenter: prefix(set("-t", "-S", "-G", "--target")),
  firejail: prefix(),
  bwrap: (a) => {
    const dd = a.indexOf("--");
    return dd !== -1 ? { inner: a.slice(dd + 1) } : null;
  },
  "sandbox-exec": (a) => {
    const i = afterOptions(a, set("-f", "-p", "-n", "-D"));
    return i < a.length ? { inner: a.slice(i) } : null;
  },
  "xvfb-run": prefix(set("-a", "-e", "-f", "-n", "-p", "-s", "-w")),
  "dbus-run-session": prefix(),
  "systemd-run": prefix(set("-p", "--property", "--unit", "--uid", "--gid", "-E", "--setenv")),
  wsl: prefix(set("-d", "-u", "--distribution", "--user", "--cd")),
  // fan-out
  xargs: xargsWrapper,
  find: findWrapper,
  parallel: (a) => {
    const colons = a.indexOf(":::");
    const head = colons === -1 ? a : a.slice(0, colons);
    const i = afterOptions(head, set("-j", "-n", "-N", "-a", "-S", "--jobs", "--sshlogin"));
    return i < head.length ? { inner: head.slice(i) } : null;
  },
  // shells and evaluators
  ...Object.fromEntries(SHELLS.map((s) => [s, shellWrapper])),
  eval: (a) => (a.length ? { script: a.join(" ") } : null),
  script: (a) => {
    const c = a.findIndex((x) => x === "-c" || x === "--command");
    return c !== -1 && a[c + 1] ? { script: a[c + 1]! } : null;
  },
  osascript: (a) => {
    const e = a.indexOf("-e");
    const m = e !== -1 ? /do shell script "((?:[^"\\]|\\.)*)"/.exec(a[e + 1] ?? "") : null;
    return m ? { script: m[1]!.replace(/\\(.)/g, "$1") } : null;
  },
  // run other machines' commands
  ssh: remoteWrapper("ssh", sshOpts, 1),
  mosh: remoteWrapper("ssh", sshOpts, 1),
  docker: dockerRun,
  podman: dockerRun,
  nerdctl: dockerRun,
  kubectl: kubectlWrapper,
  oc: kubectlWrapper,
  // package runners: they fetch and run code
  npx: runnerWrapper(set("-p", "--package", "-c", "--call")),
  bunx: runnerWrapper(set("-p", "--package")),
  uvx: runnerWrapper(set("--from", "--with", "-p", "--python")),
  pipx: (a) => (a[0] === "run" ? runnerWrapper(set("--spec", "--python"))(a.slice(1)) : null),
  pnpm: pmRunner,
  yarn: pmRunner,
  npm: pmRunner,
  bun: pmRunner,
};

// ------------------------------------------------------------------ programs

const PKG_SUBCOMMANDS: Record<string, string[]> = {
  npm: ["install", "i", "ci", "add", "update", "up", "upgrade", "exec", "x", "link", "rebuild"],
  pnpm: ["install", "i", "add", "update", "up", "upgrade", "dlx", "link"],
  yarn: ["install", "add", "up", "upgrade", "dlx", "link"],
  bun: ["install", "i", "add", "update", "x", "link"],
  pip: ["install", "download"],
  pip3: ["install", "download"],
  uv: ["add", "sync", "pip", "tool", "run", "lock"],
  poetry: ["add", "install", "update", "lock"],
  cargo: ["install", "add", "fetch", "update"],
  gem: ["install", "update"],
  bundle: ["install", "add", "update"],
  go: ["install", "get"],
  brew: ["install", "reinstall", "upgrade", "tap", "update"],
  apt: ["install", "upgrade", "update", "dist-upgrade"],
  "apt-get": ["install", "upgrade", "update", "dist-upgrade"],
  aptitude: ["install", "upgrade"],
  dnf: ["install", "upgrade", "update"],
  yum: ["install", "upgrade", "update"],
  zypper: ["install", "update"],
  apk: ["add", "upgrade", "update"],
  pacman: ["-S", "-Sy", "-Syu"],
  composer: ["require", "install", "update"],
  dotnet: ["add", "restore", "tool"],
  pipx: ["install", "upgrade", "run"],
  conda: ["install", "create", "update"],
  mamba: ["install", "create", "update"],
  nuget: ["install", "restore"],
  gh: ["extension"],
};

const PUBLISH: Record<string, string[]> = {
  git: ["push"],
  npm: ["publish"],
  pnpm: ["publish"],
  yarn: ["publish", "npm"],
  cargo: ["publish"],
  gem: ["push"],
  poetry: ["publish"],
  twine: ["upload"],
  docker: ["push"],
  podman: ["push"],
  helm: ["push"],
  gh: ["release"],
};

const CLOUD: Record<string, { mutate?: RegExp; read?: RegExp; any?: boolean }> = {
  kubectl: {
    mutate:
      /^(apply|create|delete|patch|replace|scale|rollout|drain|cordon|uncordon|taint|label|annotate|edit|set|run|expose|autoscale|cp|debug|certificate)$/,
  },
  oc: { mutate: /^(apply|create|delete|patch|replace|scale|rollout|drain|adm|new-app|start-build|expose)$/ },
  helm: { mutate: /^(install|upgrade|uninstall|rollback|delete|push)$/ },
  terraform: { mutate: /^(apply|destroy|import|taint|untaint|force-unlock|state|workspace)$/ },
  tofu: { mutate: /^(apply|destroy|import|taint|untaint|force-unlock|state|workspace)$/ },
  terragrunt: { mutate: /^(apply|destroy|run-all|import)$/ },
  pulumi: { mutate: /^(up|destroy|cancel|import|state|stack)$/ },
  cdk: { mutate: /^(deploy|destroy|bootstrap)$/ },
  sam: { mutate: /^(deploy|delete|sync)$/ },
  serverless: { mutate: /^(deploy|remove|rollback)$/ },
  sls: { mutate: /^(deploy|remove|rollback)$/ },
  vercel: { mutate: /^(deploy|rm|remove|promote|env|--prod)$/ },
  netlify: { mutate: /^(deploy|sites:delete|env:set|env:unset)$/ },
  wrangler: { mutate: /^(deploy|publish|delete|secret|d1|kv|r2)$/ },
  fly: { mutate: /^(deploy|destroy|scale|secrets|apps|volumes|machine)$/ },
  flyctl: { mutate: /^(deploy|destroy|scale|secrets|apps|volumes|machine)$/ },
  heroku: {
    mutate: /^(?!(info|logs|ps|config|apps:info|releases|status|whoami|auth:whoami|domains|addons)$).+/,
  },
  firebase: { mutate: /^(deploy|functions:delete|hosting:disable|firestore:delete)$/ },
  supabase: { mutate: /^(db|functions|secrets|link|projects)$/ },
  doctl: { mutate: /^(?!(account|auth|version|help)$).+/ },
  ansible: { any: true },
  "ansible-playbook": { any: true },
};

const READ_VERB =
  /^(describe|list|get|ls|head|show|wait|view|lookup|search|batch-get|query|scan|select|help|version|whoami|get-caller-identity|diff|status|logs|info|config)\b/;
const MUTATE_VERB =
  /(^|-)(delete|remove|terminate|destroy|create|put|update|modify|run|start|stop|reboot|attach|detach|deregister|register|authorize|revoke|invoke|deploy|add|set|resize|reset|import|purge|restart|rm|rb|sync|cp|mv|apply|scale|patch|replace|release|publish|enable|disable|tag|untag|associate|disassociate|upload|copy|move|rotate|schedule|cancel|execute|submit|restore|rollback|promote)\b/;

const AGENT_PROGRAMS = new Set([
  "claude",
  "codex",
  "gemini",
  "cursor-agent",
  "opencode",
  "aider",
  "copilot",
  "goose",
  "qwen",
  "kiro",
  "droid",
  "amp",
]);
const NET_PROGRAMS = new Set([
  "curl",
  "wget",
  "http",
  "https",
  "xh",
  "aria2c",
  "fetch",
  "lynx",
  "w3m",
  "links",
  "nc",
  "ncat",
  "netcat",
  "telnet",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "ftp",
  "mosh",
  "socat",
  "dig",
  "nslookup",
  "host",
  "ping",
  "traceroute",
  "mtr",
  "nmap",
]);
const INTERPRETERS = new Set([
  ...SHELLS,
  "python",
  "python3",
  "node",
  "bun",
  "deno",
  "perl",
  "ruby",
  "php",
  "lua",
  "pwsh",
  "powershell",
  "osascript",
  "source",
  ".",
  "eval",
]);
const FETCHERS = new Set(["curl", "wget", "fetch", "http", "https", "xh", "aria2c", "nc", "ncat", "netcat"]);

/** Programs that read their path arguments, write them, delete them, or change permissions. */
const READERS = new Set([
  "cat",
  "bat",
  "less",
  "more",
  "head",
  "tail",
  "nl",
  "tac",
  "od",
  "xxd",
  "hexdump",
  "strings",
  "wc",
  "sort",
  "uniq",
  "cut",
  "paste",
  "diff",
  "cmp",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "sed",
  "awk",
  "gawk",
  "jq",
  "yq",
  "open",
  "source",
  ".",
  "base64",
  "sha256sum",
  "shasum",
  "md5sum",
  "md5",
  "openssl",
  "gpg",
  "scp",
  "rsync",
  "tar",
  "zip",
  "unzip",
  "gzip",
  "gunzip",
  "zcat",
  "7z",
  "cp",
  "type",
]);
/** Programs that only look at names and metadata, not contents. */
const LISTERS = new Set(["ls", "tree", "du", "stat", "file", "realpath", "readlink"]);
const PATTERN_FIRST = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "sed", "awk", "gawk"]);
const WRITERS = new Set([
  "cp",
  "mv",
  "install",
  "mkdir",
  "touch",
  "ln",
  "tee",
  "truncate",
  "dd",
  "patch",
  "tar",
  "zip",
  "unzip",
  "rsync",
  "scp",
  "sed",
  "git",
  "curl",
  "wget",
  "gzip",
  "gunzip",
  "mkfifo",
  "mknod",
]);
const DELETERS = new Set(["rm", "rmdir", "unlink", "shred", "trash", "mv", "wipefs", "srm"]);
const CHMODDERS = new Set(["chmod", "chown", "chgrp", "setfacl", "chattr", "xattr"]);

const SECRET_NAMES = [
  ".env",
  ".env.*",
  "*.env",
  ".envrc",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.keystore",
  "*.jks",
  "credentials",
  "credentials.json",
  "service-account*.json",
  "*.tfvars",
  "secrets.*",
  "terraform.tfstate",
  "kubeconfig",
];
const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".azure", ".kube", ".config/gcloud", ".config/gh", ".docker"];

export const secretPathGlobs = { names: SECRET_NAMES, dirs: SECRET_DIRS };

// ------------------------------------------------------------------ hosts

const URL_RE =
  /\b([a-z][a-z0-9+.-]*):\/\/(?:[^\s/@:]+(?::[^\s/@]*)?@)?(\[[0-9a-f:]+\]|[A-Za-z0-9._-]+)(?::(\d+))?/gi;
const HOSTISH = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)$/;

export function findHosts(words: readonly string[], program: string): HostUse[] {
  const out: HostUse[] = [];
  const add = (host: string, port?: number) => {
    const h = host.toLowerCase();
    const same = out.find(
      (x) => x.host === h && (x.port === port || x.port === undefined || port === undefined),
    );
    if (!same) out.push({ host: h, ...(port ? { port } : {}) });
    else if (port && same.port === undefined) same.port = port;
  };
  for (const w of words) {
    for (const m of w.matchAll(URL_RE)) {
      if (m[1]!.toLowerCase() === "file") continue;
      add(m[2]!.replace(/^\[|\]$/g, ""), m[3] ? Number(m[3]) : undefined);
    }
    // git@github.com:org/repo.git and user@host:path (scp style)
    const scp =
      /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+\.[A-Za-z]{2,}|\d{1,3}(?:\.\d{1,3}){3}):(?!\/\/)(?!\d)/.exec(w);
    if (scp && !w.includes("://")) add(scp[1]!);
  }
  if (NET_PROGRAMS.has(program)) {
    const positional = words.slice(1).filter((w) => !w.startsWith("-"));
    for (const w of positional) {
      const m = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+)(?::(\d+))?$/.exec(w);
      if (m && HOSTISH.test(m[1]!)) add(m[1]!, m[2] ? Number(m[2]) : undefined);
    }
    // nc/telnet host port
    if (["nc", "ncat", "netcat", "telnet", "socat"].includes(program)) {
      const [h, p] = positional;
      if (h && p && /^\d+$/.test(p) && HOSTISH.test(h)) add(h, Number(p));
    }
  }
  return out;
}

// ------------------------------------------------------------------ git

const GIT_VALUE_FLAGS = set(
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--exec-path",
  "--config-env",
);
const SUBCOMMAND_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  git: GIT_VALUE_FLAGS,
  aws: set("--profile", "--region", "--output", "--endpoint-url", "--query", "--cli-read-timeout"),
  kubectl: set(
    "-n",
    "--namespace",
    "--context",
    "--cluster",
    "--kubeconfig",
    "--user",
    "-s",
    "--server",
    "--as",
    "--token",
  ),
  oc: set("-n", "--namespace", "--context", "--cluster", "--kubeconfig"),
  docker: set("-H", "--host", "--context", "-l", "--log-level", "--config"),
  gcloud: set("--project", "--account", "--configuration", "--format", "--impersonate-service-account"),
  az: set("--subscription", "--output", "-o"),
  helm: set("-n", "--namespace", "--kube-context", "--kubeconfig"),
  terraform: set("-chdir"),
  cargo: set("--manifest-path", "-p", "--package"),
  npm: set("--prefix", "-C", "-w", "--workspace", "--registry"),
  pnpm: set("--prefix", "-C", "-w", "--filter", "-F", "--dir"),
  yarn: set("--cwd"),
};

function parseWords(words: readonly string[], program: string) {
  const flags: string[] = [];
  const flagValues: Record<string, string> = {};
  const args: string[] = [];
  let subcommand: string | undefined;
  let noMore = false;
  const skip = SUBCOMMAND_VALUE_FLAGS[program] ?? new Set<string>();
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (noMore) {
      args.push(w);
      continue;
    }
    if (w === "--") {
      noMore = true;
      continue;
    }
    if (w.startsWith("--") && w.length > 2) {
      const eq = w.indexOf("=");
      const name = eq === -1 ? w : w.slice(0, eq);
      flags.push(name);
      if (eq !== -1) flagValues[name] = w.slice(eq + 1);
      else if (words[i + 1] !== undefined && !words[i + 1]!.startsWith("-")) {
        flagValues[name] = words[i + 1]!;
        if (skip.has(name) && subcommand === undefined) i++;
      }
      continue;
    }
    if (w.startsWith("-") && w.length > 1 && !/^-\d+$/.test(w)) {
      for (const f of expandFlag(w, program)) flags.push(f);
      if (w.length === 2 && words[i + 1] !== undefined && !words[i + 1]!.startsWith("-")) {
        flagValues[w] = words[i + 1]!;
        if (skip.has(w) && subcommand === undefined) {
          i++;
          continue;
        }
      }
      continue;
    }
    args.push(w);
    // A subcommand is a word (commit, apply, config:set), not a URL, a path or a file name.
    if (subcommand === undefined && /^[A-Za-z][A-Za-z0-9_:-]*$/.test(w)) subcommand = w;
  }
  return { flags, flagValues, args, subcommand };
}

interface PushInfo {
  force: boolean;
  lease: boolean;
  /** Deletes a remote branch: `--delete`, `-d`, or a `:branch` refspec. */
  deleting: boolean;
  targets: string[];
}

function gitPush(args: string[], flags: string[]): PushInfo {
  const positional = args.slice(1); // after "push"
  const remoteSeen = positional.length > 0;
  const targets: string[] = [];
  let plus = false;
  let deleting = flags.includes("--delete") || flags.includes("-d");
  for (const a of remoteSeen ? positional.slice(1) : []) {
    let spec = a;
    if (spec.startsWith(":")) deleting = true;
    if (spec.startsWith("+")) {
      plus = true;
      spec = spec.slice(1);
    }
    const dst = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : spec;
    const name = dst.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "");
    if (name) targets.push(name);
  }
  return {
    force: flags.includes("--force") || flags.includes("-f") || plus,
    lease: flags.some((f) => f.startsWith("--force-with-lease") || f === "--force-if-includes"),
    deleting,
    targets,
  };
}

// ------------------------------------------------------------------ facts for one effective command

function pathUses(
  program: string,
  words: readonly string[],
  args: string[],
  flags: string[],
  redirects: Cmd["redirects"],
  ctx: AnalyzeContext,
): PathUse[] {
  const out: PathUse[] = [];
  const add = (p: string, op: FileOp) => {
    if (!p || p === "-" || p.includes("(…)")) return;
    const path = resolvePath(p, ctx);
    const e = out.find((x) => x.path === path);
    if (e) {
      if (!e.ops.includes(op)) e.ops.push(op);
    } else out.push({ path, ops: [op] });
  };
  let operands = args;
  if (
    PATTERN_FIRST.has(program) &&
    !flags.includes("-e") &&
    !flags.includes("-f") &&
    !flags.includes("--regexp")
  )
    operands = args.slice(1);
  if (["sed"].includes(program) && !flags.includes("-e")) operands = args.slice(1);
  const pathLike = (a: string) =>
    a.includes("/") ||
    a.startsWith("~") ||
    a.startsWith("$HOME") ||
    a.startsWith(".") ||
    /\.[A-Za-z0-9]{1,6}$/.test(a);
  const sub = program === "git" ? args.slice(1) : operands;
  if (READERS.has(program) || program === "git")
    for (const a of program === "git" ? sub.filter(pathLike) : operands)
      add(a, program === "git" ? "any" : "read");
  if (LISTERS.has(program)) for (const a of operands) add(a, "list");
  if (program === "find") {
    // The start paths come before the first expression; -delete removes everything under them.
    const del = words.includes("-delete");
    for (const w of words.slice(1)) {
      if (w.startsWith("-") || w === "(" || w === "!") break;
      add(w, del ? "delete" : "list");
    }
  }
  if (["docker", "podman", "nerdctl"].includes(program)) {
    // Bind mounts expose host paths to the container: -v SRC:DEST, --volume=SRC:DEST, --mount source=SRC.
    for (let i = 1; i < words.length; i++) {
      const w = words[i]!;
      const val =
        /^(?:-v|--volume)=(.*)$/.exec(w)?.[1] ?? (w === "-v" || w === "--volume" ? words[i + 1] : undefined);
      if (val) {
        const src = val.split(":")[0]!;
        if (/^(?:\/|~|\$|\.)/.test(src)) add(src, "any");
      }
      const mount = /^--mount=(.*)$/.exec(w)?.[1] ?? (w === "--mount" ? words[i + 1] : undefined);
      if (mount)
        for (const kv of mount.split(",")) {
          const m = /^(?:source|src)=(.+)$/.exec(kv);
          if (m && /^(?:\/|~|\$|\.)/.test(m[1]!)) add(m[1]!, "any");
        }
    }
  }
  if (DELETERS.has(program)) {
    const targets = program === "mv" ? operands.slice(0, -1) : operands;
    for (const a of targets) add(a, "delete");
  }
  if (CHMODDERS.has(program)) for (const a of operands.slice(1)) add(a, "chmod");
  if (
    WRITERS.has(program) &&
    !["git", "curl", "wget", "tar", "zip", "unzip", "gzip", "gunzip", "rsync", "scp", "sed"].includes(program)
  ) {
    const dest =
      program === "tee" || program === "touch" || program === "mkdir" || program === "truncate"
        ? operands
        : operands.slice(-1);
    for (const a of dest) add(a, "write");
  }
  if (program === "sed" && (flags.includes("-i") || flags.includes("--in-place")))
    for (const a of operands) add(a, "write");
  if ((program === "tar" && flags.includes("-x")) || program === "unzip" || program === "gunzip")
    for (const a of operands.slice(-1)) add(a, "write");
  if (program === "dd")
    for (const w of words) {
      if (w.startsWith("of=")) add(w.slice(3), "write");
      if (w.startsWith("if=")) add(w.slice(3), "read");
    }
  if (program === "curl" || program === "wget")
    for (const f of ["-o", "-O", "--output", "--output-document"]) {
      const v = words[words.indexOf(f) + 1];
      if (words.includes(f) && v && !v.startsWith("-")) add(v, "write");
    }
  for (const r of redirects) add(r.target, r.op === "<" ? "read" : r.op === "<<" ? "any" : "write");
  return out;
}

function capsFor(
  program: string,
  sub: string | undefined,
  args: string[],
  flags: string[],
  paths: PathUse[],
  hosts: HostUse[],
  push: PushInfo | null,
): string[] {
  const caps = new Set<string>();
  if (paths.some((p) => p.ops.includes("read") || p.ops.includes("any"))) caps.add("fs.read");
  if (paths.some((p) => p.ops.some((o) => o === "write" || o === "delete" || o === "chmod")))
    caps.add("fs.write");
  if (hosts.length || NET_PROGRAMS.has(program)) caps.add("net.fetch");
  if (sub && PKG_SUBCOMMANDS[program]?.includes(sub)) {
    caps.add("pkg.install");
    caps.add("net.fetch");
  }
  if (
    sub &&
    PUBLISH[program]?.includes(sub) &&
    !(program === "gh" && !["create", "upload"].includes(args[1] ?? ""))
  )
    caps.add("vcs.publish");
  if (program === "git") {
    if (sub && ["clone", "fetch", "pull", "push", "ls-remote"].includes(sub)) caps.add("net.fetch");
    if (sub === "push" && push && (push.force || push.deleting)) caps.add("vcs.rewrite");
    if (sub && ["rebase", "filter-branch", "filter-repo"].includes(sub)) caps.add("vcs.rewrite");
    if (sub === "reset" && flags.includes("--hard")) caps.add("vcs.rewrite");
    if (sub === "commit" && flags.includes("--amend")) caps.add("vcs.rewrite");
    if (sub === "branch" && (flags.includes("-D") || flags.includes("-d") || flags.includes("--delete")))
      caps.add("vcs.rewrite");
  }
  const cloud = CLOUD[program];
  if (cloud) {
    const verbs = args.slice(0, 4);
    if (cloud.any || (cloud.mutate && verbs.some((v) => cloud.mutate!.test(v)))) caps.add("cloud.mutate");
  } else if (["aws", "gcloud", "az"].includes(program)) {
    caps.add("net.fetch");
    const rest = program === "aws" ? args.slice(1, 3) : args.slice(0, 4);
    const verb =
      program === "aws"
        ? (args[1] ?? "")
        : (rest.find((v) => MUTATE_VERB.test(v) || READ_VERB.test(v)) ?? "");
    if (program === "aws" && args[0] === "s3") {
      if (/^(rm|rb|sync|cp|mv|mb)$/.test(args[1] ?? "")) caps.add("cloud.mutate");
    } else if (MUTATE_VERB.test(verb) && !READ_VERB.test(verb)) caps.add("cloud.mutate");
  }
  if (program === "docker" && sub && ["push", "login"].includes(sub)) caps.add("net.fetch");
  if (AGENT_PROGRAMS.has(program)) caps.add("agent.spawn");
  if (paths.some((p) => isSecretPath(p.path))) caps.add("secret.read");
  return [...caps].sort();
}

/** Is this path a credential or secret-bearing file? Deliberately strict: `.env.example` counts. */
export function isSecretPath(path: string): boolean {
  const name = basename(path);
  for (const g of SECRET_NAMES) if (globToRegExp(g).test(name)) return true;
  const norm = path.replace(/\/+$/, "");
  for (const d of SECRET_DIRS)
    if (norm.includes(`/${d}/`) || norm.endsWith(`/${d}`) || norm.startsWith(`${d}/`)) return true;
  return false;
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        // `**/` is zero or more directories: `**/x` matches `x` and `/a/b/x`, not `/a/not-x`.
        if (glob[i + 1] === "/") {
          re += "(?:.*/)?";
          i++;
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const e = glob.indexOf("}", i);
      if (e === -1) re += "\\{";
      else {
        re += `(?:${glob
          .slice(i + 1, e)
          .split(",")
          .map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
          .join("|")})`;
        i = e;
      }
    } else re += c.replace(/[.+^$()|[\]\\/]/g, (m) => (m === "/" ? "/" : `\\${m}`));
  }
  return new RegExp(`^${re}$`);
}

function factsFor(
  words: string[],
  cmd: Cmd,
  wrappers: string[],
  extra: { hosts?: string[]; remote?: string; caps?: string[]; fetchesCode?: boolean },
  ctx: AnalyzeContext,
  source?: string,
): Facts {
  const program = base(words[0] ?? "");
  const { flags, flagValues, args, subcommand } = parseWords(words, program);
  const hosts = findHosts(words, program);
  for (const h of extra.hosts ?? [])
    if (h && !hosts.some((x) => x.host === h.toLowerCase())) hosts.push({ host: h.toLowerCase() });
  const paths = pathUses(program, words, args, flags, cmd.redirects, ctx);
  const push = program === "git" && subcommand === "push" ? gitPush(args, flags) : null;
  const caps = new Set(capsFor(program, subcommand, args, flags, paths, hosts, push));
  for (const c of extra.caps ?? []) caps.add(c);
  if (extra.fetchesCode) caps.add("net.fetch");
  return {
    program,
    ...(subcommand ? { subcommand } : {}),
    args,
    flags,
    flagValues,
    paths,
    hosts,
    capabilities: [...caps].sort(),
    wrappers,
    forcePush: push?.force ?? false,
    forceWithLease: push?.lease ?? false,
    pushTarget: push?.targets ?? [],
    raw: cmd.raw,
    ...(extra.remote ? { remote: extra.remote } : {}),
    ...(source ? { source } : {}),
  };
}

// ------------------------------------------------------------------ one-line scripts

const ONE_LINERS: Record<string, string[]> = {
  python: ["-c"],
  python3: ["-c"],
  node: ["-e", "--eval", "-p"],
  bun: ["-e", "--eval"],
  deno: ["eval"],
  ruby: ["-e"],
  perl: ["-e", "-E"],
  php: ["-r"],
  lua: ["-e"],
};

/** URLs and absolute-looking path literals inside an inline script (python -c, node -e, …). */
function scanCode(code: string, ctx: AnalyzeContext): { hosts: HostUse[]; paths: PathUse[] } {
  const hosts = findHosts([code], "");
  const paths: PathUse[] = [];
  for (const m of code.matchAll(/["'`]((?:~|\$HOME|\/)[A-Za-z0-9._\-/~$]{2,})["'`]/g))
    if (!/^\/\/|^\/[a-z]+:/.test(m[1]!)) paths.push({ path: resolvePath(m[1]!, ctx), ops: ["any"] });
  return { hosts, paths };
}

// ------------------------------------------------------------------ scripts, Makefiles, package.json

interface ScriptHit {
  text: string;
  source: string;
}

function findScripts(program: string, firstWord: string, args: string[], ctx: AnalyzeContext): ScriptHit[] {
  if (!ctx.readFile || !ctx.cwd) return [];
  const read = (p: string) => {
    const t = ctx.readFile!(resolve(ctx.cwd!, p));
    return t !== null && t.length <= MAX_SCRIPT_BYTES ? t : null;
  };
  const hits: ScriptHit[] = [];
  const pm = ["npm", "pnpm", "yarn", "bun"];
  if (pm.includes(program)) {
    const sub = args[0];
    const name =
      sub === "run" || sub === "run-script"
        ? args[1]
        : ["test", "start", "stop", "restart", "build"].includes(sub ?? "") ||
            (program !== "npm" &&
              sub &&
              ![
                "install",
                "add",
                "i",
                "ci",
                "x",
                "dlx",
                "exec",
                "publish",
                "update",
                "up",
                "remove",
                "rm",
                "link",
                "init",
                "create",
                "pack",
                "audit",
                "config",
                "cache",
                "outdated",
                "ls",
                "list",
              ].includes(sub))
          ? sub
          : undefined;
    if (name) {
      const pkg = read("package.json");
      if (pkg) {
        try {
          const scripts = (JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts ?? {};
          for (const k of [`pre${name}`, name, `post${name}`])
            if (typeof scripts[k] === "string") hits.push({ text: scripts[k]!, source: `package.json:${k}` });
        } catch {}
      }
    }
  }
  if (program === "make" || program === "gmake") {
    const mk = read("Makefile") ?? read("makefile") ?? read("GNUmakefile");
    if (mk) {
      const wanted = args.filter((a) => !a.includes("="));
      for (const t of wanted.length ? wanted : [""]) {
        const recipe = makeRecipe(mk, t);
        if (recipe) hits.push({ text: recipe, source: `Makefile:${t || "default"}` });
      }
    }
  }
  const isShell = SHELLS.includes(program) || program === "source" || program === ".";
  const file = isShell
    ? args.find((a) => !a.startsWith("-"))
    : firstWord.includes("/")
      ? firstWord
      : undefined;
  if (file && !file.includes("(…)")) {
    const t = read(expandHome(file, ctx.home ?? homedir()));
    if (t !== null && (isShell || /^#!.*\b(ba|z|da|k)?sh\b/.test(t) || /\.(sh|bash|zsh)$/.test(file)))
      hits.push({ text: t, source: file });
  }
  return hits;
}

/** The recipe lines of a Makefile target (the first target when `target` is empty). */
function makeRecipe(mk: string, target: string): string | null {
  const lines = mk.split("\n");
  let i = lines.findIndex((l) =>
    target
      ? new RegExp(`^${target.replace(/[.+^$()|[\]\\*?]/g, "\\$&")}\\s*:`).test(l)
      : /^[A-Za-z0-9_.%/-]+\s*:(?!=)/.test(l) && !l.startsWith("."),
  );
  if (i === -1) return null;
  const out: string[] = [];
  const rest = lines[i]!.replace(/^[^:]*:\s*[^#]*(;\s*)?/, "");
  if (lines[i]!.includes(";")) out.push(rest);
  for (i++; i < lines.length && (lines[i]!.startsWith("\t") || lines[i]!.trim() === ""); i++) {
    const l = lines[i]!.replace(/^\t[@+-]*/, "").trim();
    if (l) out.push(l);
  }
  return out.join("\n");
}

// ------------------------------------------------------------------ the analysis

const FORK_BOMB =
  /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&[^}]*\}\s*;?\s*:|\b(\w+)\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*;\s*\1\b/;

/** Analyse a shell command line. */
export function analyze(command: string, ctx: AnalyzeContext = {}): Analysis {
  const commands: Facts[] = [];
  const patterns = new Set<string>();
  let truncated = false;

  const visit = (text: string, wrappers: string[], depth: number, source?: string) => {
    const cmds = parseShell(text);
    if (FORK_BOMB.test(text.replace(/\s+/g, " "))) patterns.add("fork-bomb");
    detectPipelinePatterns(cmds, patterns);
    for (const cmd of cmds) {
      if (commands.length >= MAX_FACTS) {
        truncated = true;
        return;
      }
      if (!cmd.words.length) {
        // `> file` alone, or only assignments: a redirect still writes.
        if (cmd.redirects.length) commands.push(factsFor(["true"], cmd, wrappers, {}, ctx, source));
        continue;
      }
      effective(cmd.words, cmd, wrappers, {}, depth, source);
    }
  };

  const effective = (
    words: string[],
    cmd: Cmd,
    wrappers: string[],
    carry: { hosts?: string[]; remote?: string; caps?: string[]; fetchesCode?: boolean },
    depth: number,
    source?: string,
  ) => {
    if (depth > 8) {
      truncated = true;
      return;
    }
    const prog = base(words[0] ?? "");
    // `pnpm run x` is not a package runner; only dlx/exec/x are. Wrappers return null when not applicable.
    const w = WRAPPERS[prog]?.(words.slice(1));
    if (w) {
      const wrapped = [...wrappers, prog];
      const next = {
        hosts: [...(carry.hosts ?? []), ...(w.hosts ?? [])],
        remote: w.remote ?? carry.remote,
        caps: [...(carry.caps ?? []), ...(w.caps ?? [])],
        fetchesCode: carry.fetchesCode || w.fetchesCode,
      };
      if (w.script !== undefined) {
        if (/^\s*["']?\$\(|^\s*`|^\s*<\(/.test(w.script) && /\b(curl|wget|fetch)\b/.test(w.script))
          patterns.add("download-and-run");
        const inner = parseShell(w.script, 1);
        detectPipelinePatterns(inner, patterns);
        if (FORK_BOMB.test(w.script.replace(/\s+/g, " "))) patterns.add("fork-bomb");
        // The wrapper itself (ssh talks to a host) is a command too.
        if (prog === "ssh" || prog === "mosh")
          commands.push(factsFor(words, cmd, wrappers, next, ctx, source));
        for (const c of inner)
          if (c.words.length) effective(c.words, c, wrapped, next, depth + 1, source);
          else if (c.redirects.length) commands.push(factsFor(["true"], c, wrapped, next, ctx, source));
        return;
      }
      if (w.inner) {
        // docker run -v ~/.aws:/root/.aws img cmd: the wrapper's own flags (mounts) matter too.
        if (w.remote) commands.push(factsFor(words, cmd, wrappers, next, ctx, source));
        effective(w.inner, cmd, wrapped, next, depth + 1, source);
        // Facts about the wrapper's own hosts (ssh/docker) are kept on the inner command.
        return;
      }
      if (w.remote) {
        commands.push(factsFor(words, cmd, wrappers, next, ctx, source));
        return;
      }
    }
    // A shell reading code from a heredoc or a pipe: `bash <<EOF … EOF`.
    if (SHELLS.includes(prog) && cmd.heredoc && !words.slice(1).some((a) => !a.startsWith("-"))) {
      commands.push(factsFor(words, cmd, wrappers, carry, ctx, source));
      for (const c of parseShell(cmd.heredoc, 1))
        if (c.words.length) effective(c.words, c, [...wrappers, prog], carry, depth + 1, source);
      return;
    }
    const f = factsFor(words, cmd, wrappers, carry, ctx, source);
    // One-line scripts: python -c, node -e, …
    const ol = ONE_LINERS[prog];
    if (ol) {
      const idx = words.findIndex((x) => ol.includes(x));
      const code = idx !== -1 ? words[idx + 1] : undefined;
      if (code) {
        const s = scanCode(code, ctx);
        for (const h of s.hosts) if (!f.hosts.some((x) => x.host === h.host)) f.hosts.push(h);
        for (const p of s.paths) f.paths.push(p);
        const caps = new Set(f.capabilities);
        if (s.hosts.length) caps.add("net.fetch");
        if (s.paths.length) caps.add("fs.read");
        if (s.paths.some((p) => isSecretPath(p.path))) caps.add("secret.read");
        if (
          /os\.environ\b|process\.env\b|ENV\.to_h|\$ENV\b/.test(code) &&
          /print|dump|json|console\.log|puts|echo/.test(code) &&
          !/os\.environ\[|os\.environ\.get|process\.env\.[A-Z_]+|process\.env\[/.test(code)
        )
          patterns.add("env-dump");
        f.capabilities = [...caps].sort();
      }
    }
    commands.push(f);
    // Environment dump: env, printenv, export -p, declare -x, set (no operands).
    if (["env", "printenv"].includes(f.program) && f.args.length === 0) patterns.add("env-dump");
    if (
      ["export", "declare", "typeset"].includes(f.program) &&
      f.args.length === 0 &&
      (f.flags.length === 0 || f.flags.every((x) => ["-p", "-x"].includes(x)))
    )
      patterns.add("env-dump");
    if (f.program === "set" && f.args.length === 0 && f.flags.length === 0) patterns.add("env-dump");
    if (f.paths.some((p) => /^\/proc\/(?:self|\d+|\*)\/environ$/.test(p.path))) patterns.add("env-dump");
    if (
      f.capabilities.includes("secret.read") &&
      !patterns.has("env-dump") &&
      f.program === "cat" &&
      f.paths.some((p) => /environ$/.test(p.path))
    )
      patterns.add("env-dump");
    for (const s of findScripts(
      f.program === "source" || f.program === "." ? f.program : prog,
      words[0] ?? "",
      f.program === prog ? f.args : words.slice(1).filter((a) => !a.startsWith("-")),
      ctx,
    )) {
      if (s.source === source) continue;
      if ((source?.split(">").length ?? 0) >= MAX_SCRIPT_DEPTH) {
        truncated = true;
        continue;
      }
      visit(s.text, wrappers, depth + 1, source ? `${source}>${s.source}` : s.source);
    }
  };

  visit(command, [], 0);
  return { commands, patterns: [...patterns].sort(), truncated };
}

/** download-and-run: a fetcher whose output feeds an interpreter, directly or by substitution. */
function detectPipelinePatterns(cmds: Cmd[], patterns: Set<string>): void {
  const innerProgram = (c: Cmd): string => {
    let w = c.words;
    for (let i = 0; i < 6 && w.length; i++) {
      const p = base(w[0]!);
      const un = WRAPPERS[p]?.(w.slice(1));
      if (!un?.inner) return p;
      w = un.inner;
    }
    return base(w[0] ?? "");
  };
  for (let i = 0; i < cmds.length; i++) {
    const c = cmds[i]!;
    if (c.words.length === 0) continue;
    // curl … | sh   (any later stage of the same pipeline that is an interpreter)
    if (FETCHERS.has(base(c.words[0]!)) || FETCHERS.has(innerProgram(c)))
      for (let j = i + 1; j < cmds.length && cmds[j]!.pipeline === c.pipeline; j++)
        if (cmds[j]!.words.length && INTERPRETERS.has(innerProgram(cmds[j]!)))
          patterns.add("download-and-run");
    // sh <(curl …),  . <(curl …),  eval "$(curl …)",  source /dev/stdin <<< "$(curl …)"
    if (
      c.substitutionOf !== undefined &&
      (FETCHERS.has(innerProgram(c)) ||
        cmds.slice(i).some((x) => x.substitutionOf === c.substitutionOf && FETCHERS.has(innerProgram(x))))
    ) {
      const owner = cmds[c.substitutionOf];
      if (owner?.words.length && INTERPRETERS.has(innerProgram(owner))) patterns.add("download-and-run");
    }
  }
}
