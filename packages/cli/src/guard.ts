import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths, resolveProject } from "@sieve/core";
import {
  type Action,
  Guard,
  type GuardEvent,
  merged,
  PRESET_ORDER,
  type PresetName,
  presetRules,
} from "@sieve/guard";
import { parse } from "smol-toml";

/** `sieve guard check | test | log | mode | init` (slice 7). */

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, v === undefined || v.startsWith("--") ? 1 : 2);
  return v === undefined || v.startsWith("--") ? "" : v;
};
const has = (args: string[], name: string) => {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
};

const guardFor = () => new Guard({ sieveHome: paths.home() });
const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 90
    ? `${s}s ago`
    : s < 5400
      ? `${Math.round(s / 60)}m ago`
      : s < 129600
        ? `${Math.round(s / 3600)}h ago`
        : `${Math.round(s / 86400)}d ago`;
};

function describePolicy(g: Guard, cwd: string): string[] {
  const ref = resolveProject(cwd);
  const p = g.policy(ref.root, ref.worktree);
  const out = [
    `mode ${p.mode} · preset ${p.preset} · ${p.rules.length} rules from ${p.files.length ? p.files.map((f) => `${f.scope} (${f.path})`).join(", ") : "the preset only (no guard.toml found)"}`,
  ];
  for (const e of p.errors) out.push(`! ${e.path} is not used: ${e.error}`);
  return out;
}

async function check(args: string[]): Promise<number> {
  const read = flag(args, "--read");
  const write = flag(args, "--write");
  const url = flag(args, "--url");
  const cwd = process.cwd();
  const ref = resolveProject(cwd);
  const g = guardFor();
  let event: GuardEvent;
  if (read !== undefined) event = { tool: "Read", family: "read", input: { path: read }, cwd };
  else if (write !== undefined) event = { tool: "Write", family: "edit", input: { path: write }, cwd };
  else if (url !== undefined) event = { tool: "WebFetch", family: "web", input: { url }, cwd };
  else {
    const command = args.join(" ").trim();
    if (!command) {
      console.error("usage: sieve guard check <command> | --read <path> | --write <path> | --url <url>");
      return 2;
    }
    event = { tool: "Bash", family: "shell", input: { command }, cwd };
  }
  event = { ...event, worktree: ref.worktree, repoRoot: ref.root };
  const policy = g.policy(ref.root, ref.worktree);
  const { subjects, analysis } = g.subjectsFor(event);
  for (const l of describePolicy(g, cwd)) console.log(l);
  console.log("");
  if (!subjects.length) console.log("nothing to check (no command, path or URL found)");
  for (const s of subjects) {
    const bits = [
      s.wrappers.length ? `via ${s.wrappers.join(" → ")}` : "",
      s.subcommand ? `subcommand ${s.subcommand}` : "",
      s.flags.length ? `flags ${s.flags.join(" ")}` : "",
      s.paths.length ? `paths ${s.paths.map((p) => `${p.path} [${p.ops.join(",")}]`).join(", ")}` : "",
      s.hosts.length ? `hosts ${s.hosts.map((h) => h.host + (h.port ? `:${h.port}` : "")).join(", ")}` : "",
      s.pushTarget.length ? `push to ${s.pushTarget.join(", ")}${s.forcePush ? " (force)" : ""}` : "",
      s.remote ? `on ${s.remote}` : "",
      s.source ? `from ${s.source}` : "",
    ].filter(Boolean);
    console.log(`  ${s.program}${bits.length ? ` · ${bits.join(" · ")}` : ""}`);
    if (s.capabilities.length) console.log(`    capabilities: ${s.capabilities.join(", ")}`);
  }
  if (analysis.patterns.length) console.log(`  patterns: ${analysis.patterns.join(", ")}`);
  if (analysis.truncated) console.log("  (analysis stopped at its size/depth limit)");
  const r = g.evaluate(event, policy, false);
  console.log("");
  const d = r.decision;
  console.log(`decision: ${d.action}${d.ruleId ? ` by ${d.ruleId} (${d.scope})` : ""}`);
  if (d.reason) console.log(`  reason: ${d.reason}`);
  if (d.alternative) console.log(`  safer:  ${d.alternative}`);
  if (d.matched.length > 1)
    console.log(
      `  also matched: ${d.matched
        .filter((m) => m.id !== d.ruleId)
        .map((m) => `${m.id} (${m.action})`)
        .join(", ")}`,
    );
  if (d.action === "deny" || d.action === "ask")
    console.log(
      policy.mode === "enforce"
        ? `  in enforce mode this is ${d.action === "ask" ? "sent to the agent's approval prompt (or refused where it has none)" : "blocked"}`
        : `  in ${policy.mode} mode this is allowed and logged as would-${d.action}; \`sieve guard mode enforce\` turns blocking on`,
    );
  return d.action === "deny" ? 1 : 0;
}

async function test(args: string[]): Promise<number> {
  const g = guardFor();
  const cwd = process.cwd();
  const ref = resolveProject(cwd);
  const want = flag(args, "--preset");
  let total = 0;
  const failures: Array<{
    where: string;
    rule: string;
    input: string;
    expected: Action;
    got: Action;
    by?: string;
  }> = [];
  const run = (
    where: string,
    rules: Parameters<Guard["runTests"]>[0],
    policy: ReturnType<Guard["policy"]>,
  ) => {
    const r = g.runTests(rules, policy);
    total += r.total;
    for (const f of r.failures) failures.push({ where, ...f });
    console.log(`${where}: ${r.total} test${r.total === 1 ? "" : "s"}, ${r.failures.length} failed`);
  };
  const names: PresetName[] = want ? [want as PresetName] : PRESET_ORDER;
  for (const name of names) {
    if (!PRESET_ORDER.includes(name)) {
      console.error(`unknown preset ${name}; known: ${PRESET_ORDER.join(", ")}`);
      return 2;
    }
    // Test a preset with the policy that has it selected, so inherited rules are not mixed in.
    const policy = {
      ...g.policy(ref.root, ref.worktree),
      preset: name,
      rules: presetRules(name, merged()).map((rule) => ({ rule, scope: "preset" as const })),
    };
    run(
      `preset ${name}`,
      presetRules(name, merged()).filter((r) => r.id.startsWith(`${name}.`)),
      policy,
    );
  }
  if (!want) {
    const policy = g.policy(ref.root, ref.worktree);
    for (const f of policy.files) run(`${f.scope} ${f.path}`, f.file.rule ?? [], policy);
    for (const e of policy.errors) {
      failures.push({
        where: e.path,
        rule: "(file)",
        input: "",
        expected: "allow",
        got: "deny",
        by: e.error,
      });
      console.log(`${e.path}: cannot be used: ${e.error}`);
    }
  }
  for (const f of failures)
    console.log(
      `  FAIL ${f.where} · ${f.rule}: ${f.input ? `\`${f.input}\` expected ${f.expected}, got ${f.got}${f.by ? ` (by ${f.by})` : ""}` : (f.by ?? "")}`,
    );
  console.log(`\n${total} tests, ${failures.length} failed`);
  return failures.length ? 1 : 0;
}

async function log(args: string[]): Promise<number> {
  const g = guardFor();
  const verify = has(args, "--verify");
  const json = has(args, "--json");
  const n = Number(flag(args, "-n") ?? 20);
  if (verify) {
    const v = g.audit.verify();
    console.log(
      v.ok
        ? `ok: ${v.rows} rows, the chain is unbroken`
        : `BROKEN at row ${v.brokenAt} of ${v.rows}: ${v.reason}`,
    );
    if (!v.ok) return 1;
  }
  const rows = g.audit.rows().slice(-n);
  if (json) {
    for (const r of rows) console.log(JSON.stringify(r));
    return 0;
  }
  if (!rows.length && !verify) console.log(`no Guard decisions recorded yet (${g.audit.file})`);
  for (const r of rows)
    console.log(
      `${String(r.seq).padStart(5)}  ${ago(r.at).padEnd(8)} ${r.decision.padEnd(10)} ${(r.rule ?? "").padEnd(34)} ${r.tool ?? ""}${r.program ? ` ${r.program}` : ""}${r.host ? ` → ${r.host}` : ""}${r.path ? ` ${r.path}` : ""}${r.note ? ` ${r.note}` : ""}`,
    );
  return 0;
}

const TEMPLATE = (mode: string, preset: string) =>
  `# Sieve Guard policy (see DESIGN.md §7). Keys are kept in this order.\nmode = "${mode}"\npreset = "${preset}"\n`;

async function mode(args: string[]): Promise<number> {
  const to = args.shift();
  const reason = flag(args, "--reason")?.trim();
  if (to !== "enforce" && to !== "monitor") {
    console.error('usage: sieve guard mode <enforce|monitor> [--reason "why"]');
    return 2;
  }
  const g = guardFor();
  const file = g.userFile();
  const before = g.policy().mode; // also records the policy as it is now, so the change below is seen as a change
  // Loosening needs a reason, and the reason goes in the audit log.
  if (to === "monitor" && before === "enforce" && !reason) {
    console.error('Turning enforcement off needs a reason: sieve guard mode monitor --reason "why"');
    return 2;
  }
  if (reason) g.noteReason(reason);
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, TEMPLATE(to, "balanced"));
  } else {
    const text = readFileSync(file, "utf8");
    // Replace the top-level `mode =` line; anything else in the file is left exactly as it was.
    const top = text.split(/^\[/m)[0] ?? "";
    const next = /^mode\s*=/m.test(top)
      ? text.replace(/^mode\s*=.*$/m, `mode = "${to}"`)
      : `mode = "${to}"\n${text}`;
    parse(next); // refuse to write a file that no longer parses
    writeFileSync(file, next);
  }
  guardFor().policy(); // a fresh reader sees the change and records it, with the reason
  console.log(
    `Guard mode: ${before} → ${to}${to === "enforce" ? ". Calls the rules deny are now blocked; asks go to the agent's approval prompt." : ". Nothing is blocked; what would have been is logged."}`,
  );
  return 0;
}

async function init(args: string[]): Promise<number> {
  const preset = (args.shift() ?? "balanced") as PresetName;
  if (!PRESET_ORDER.includes(preset)) {
    console.error(`unknown preset ${preset}; known: ${PRESET_ORDER.join(", ")}`);
    return 2;
  }
  const file = guardFor().userFile();
  if (existsSync(file)) {
    console.error(`${file} already exists; edit it, or use \`sieve guard mode\``);
    return 1;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, TEMPLATE("enforce", preset));
  console.log(`Wrote ${join(file)} (enforce mode, ${preset} preset). Try: sieve guard check "rm -rf /"`);
  return 0;
}

export async function guardCommand(args: string[]): Promise<number> {
  const sub = args.shift();
  switch (sub) {
    case "check":
      return check(args);
    case "test":
      return test(args);
    case "log":
      return log(args);
    case "mode":
      return mode(args);
    case "init":
      return init(args);
    default:
      console.error("usage: sieve guard check|test|log|mode|init (see `sieve --help`)");
      return sub ? 2 : 0;
  }
}

/** One status line: mode, preset, what the last day looked like. */
export function guardStatusLine(): { text: string; problems: string[] } {
  const g = guardFor();
  const ref = resolveProject(process.cwd());
  const p = g.policy(ref.root, ref.worktree);
  const since = Date.now() - 86_400_000;
  const rows = g.audit.rows().filter((r) => r.at >= since);
  const would = rows.filter((r) => r.decision.startsWith("would-")).length;
  const blocked = rows.filter((r) => r.decision === "deny" || r.decision === "ask").length;
  const v = g.audit.verify();
  const unexplained = g.audit
    .rows()
    .filter((r) => r.decision === "policy-loosened" && r.at >= Date.now() - 7 * 86_400_000);
  const problems = [
    ...p.errors.map((e) => `${e.path} is not used: ${e.error}`),
    ...(v.ok ? [] : [`audit log chain is broken at row ${v.brokenAt}: ${v.reason}`]),
    ...unexplained.map((r) => `the policy was loosened without a reason (${ago(r.at)}): ${r.note}`),
  ];
  return {
    text: `${p.mode} · preset ${p.preset} · last 24 h: ${blocked} blocked/asked, ${would} would have been${p.mode === "monitor" && would ? " (turn on blocking: sieve guard mode enforce)" : ""}`,
    problems,
  };
}
