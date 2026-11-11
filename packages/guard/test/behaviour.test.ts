import { describe, expect, test } from "bun:test";
import { parseSandboxLine } from "../../daemon/src/behaviour.ts";
import { checkClause, defaultPolicy, GrantError, seatbeltProfile } from "../../sandbox/src/index.ts";
import {
  compileBehaviour,
  describeObserved,
  evaluateObserved,
  extRegex,
  globRegex,
  merged,
  nameRegex,
  type Observed,
  parsePolicyFile,
  presetRules,
  type SourceRule,
  subjectFor,
} from "../src/index.ts";

const HOME = "/home/u";
const rules = (toml: object): SourceRule[] => {
  const p = parsePolicyFile(toml);
  if (!p.ok) throw new Error(p.error);
  return (p.file.rule ?? []).map((rule) => ({ rule, scope: "user" as const }));
};
const preset = (): SourceRule[] =>
  presetRules("balanced", merged()).map((rule) => ({ rule, scope: "preset" as const }));
const compile = (r: SourceRule[], mode: "enforce" | "monitor", extra = {}) =>
  compileBehaviour(r, mode, { home: HOME, cwd: "/work/proj", ...extra });

describe("globs become anchored, escaped Seatbelt regexes", () => {
  test.each([
    ["**/.env", '#"^.*/\\.env$"'],
    ["**/.env.*", '#"^.*/\\.env\\.[^/]*$"'],
    ["/dev/sd*", '#"^/dev/sd[^/]*$"'],
    ["**/*.{pem,key}", '#"^.*/[^/]*\\.(pem|key)$"'],
    ["/a+b/(c)", '#"^/a\\+b/\\(c\\)$"'],
    ["file?.txt", '#"^file[^/]\\.txt$"'],
  ])("%s", (glob, re) => expect(globRegex(glob)).toBe(re));
  test("characters that could end a string or the profile are refused", () => {
    for (const bad of ['a"b', "a\nb", 'x") (allow default) ("']) expect(() => globRegex(bad)).toThrow();
  });
});

describe("names compile only into shapes the sandbox was seen to report", () => {
  test.each([
    [".env", '#"/\\.env$"'],
    ["id_rsa", '#"/id_rsa$"'],
    ["*.pem", '#"\\.pem$"'],
    [".env.*", '#"/\\.env\\.[^/]*$"'],
    ["secret-*.txt", '#"/secret-[^/]*\\.txt$"'],
    ["mkfs.*", '#"/mkfs\\.[^/]*$"'],
    ["a+b(1)", '#"/a\\+b\\(1\\)$"'],
  ])("%s", (name, re) => expect(nameRegex(name)).toBe(re));
  test("a fancier glob falls back to the generic translation", () => {
    expect(nameRegex("*-*.{a,b}")).toContain("(a|b)");
  });
  test("an extension is a suffix", () => {
    expect(extRegex("pem")).toBe('#"\\.pem$"');
    expect(extRegex(".key")).toBe('#"\\.key$"');
  });
  test("the exact-name and suffix shapes cannot match a longer name", () => {
    // /\.env$ matches ".env" as a whole last path segment, not "x.env" or ".envrc".
    const re = () => new RegExp(nameRegex(".env").slice(2, -1));
    expect(re().test("/a/.env")).toBe(true);
    expect(re().test("/a/x.env")).toBe(false);
    expect(re().test("/a/.envrc")).toBe(false);
  });
});

describe("which rules can be expressed to the kernel", () => {
  test("a file rule becomes a read clause in monitor mode and a deny in enforce mode", () => {
    const r = rules({
      rule: [
        { id: "u.no-secrets", action: "deny", match: { file: { name: ["secret-*.txt"], ops: ["read"] } } },
      ],
    });
    const mon = compile(r, "monitor");
    expect(mon.deny).toEqual([]);
    expect(mon.report).toEqual(['(allow file-read* (regex #"/secret-[^/]*\\.txt$") (with report))']);
    const enf = compile(r, "enforce");
    expect(enf.deny).toEqual(['(deny file-read* (regex #"/secret-[^/]*\\.txt$"))']);
    expect(enf.report).toEqual([]);
  });
  test("ask and log rules are only ever reported, even when enforcing", () => {
    const c = compile(preset(), "enforce");
    expect(c.report.some((l) => l.includes("\\.env"))).toBe(true); // balanced.env-files is ask
    expect(c.deny.some((l) => l.includes("\\.env"))).toBe(false);
  });
  test("program rules match the executable's name, ports and addresses are network clauses", () => {
    const r = rules({
      rule: [
        { id: "u.no-base64", action: "deny", match: { program: "base64" } },
        { id: "u.no-port", action: "deny", match: { port: [8080, 9090] } },
        { id: "u.no-metadata", action: "deny", match: { host: ["169.254.169.254"] } },
      ],
    });
    const c = compile(r, "enforce");
    expect(c.deny).toEqual([
      '(deny process-exec* (require-any (regex #"/base64$")))',
      '(deny network-outbound (require-any (remote ip "*:8080") (remote ip "*:9090")))',
      '(deny network-outbound (remote ip "169.254.169.254:*"))',
    ]);
  });
  test("directory rules use subpath, with ~ and relative dirs resolved", () => {
    const r = rules({
      rule: [
        {
          id: "u.d",
          action: "deny",
          match: { file: { under: ["~/.cache/x", "vault"], ops: ["read", "write"] } },
        },
      ],
    });
    const c = compile(r, "enforce");
    expect(c.deny).toEqual(
      expect.arrayContaining([
        '(deny file-read* (require-any (subpath "/home/u/.cache/x") (subpath "/work/proj/vault")))',
      ]),
    );
    expect(c.deny).toEqual(
      expect.arrayContaining([
        '(deny file-write* (require-any (subpath "/home/u/.cache/x") (subpath "/work/proj/vault")))',
      ]),
    );
  });
  test("rules that need the command itself stay static, with the reason", () => {
    const c = compile(preset(), "enforce");
    const why = Object.fromEntries(c.skipped.map((s) => [s.id, s.why]));
    expect(why["balanced.rm-system"]).toContain("needs the command itself");
    expect(why["balanced.download-and-run"]).toContain("needs the command itself");
    expect(why["balanced.force-push-protected"]).toContain("needs the command itself");
    const mixed = compile(
      rules({ rule: [{ id: "u.mix", action: "deny", match: { program: "x", port: [1] } }] }),
      "enforce",
    );
    expect(mixed.skipped[0]!.why).toContain("mixes");
    const named = compile(
      rules({ rule: [{ id: "u.h", action: "deny", match: { host: ["evil.example"] } }] }),
      "enforce",
    );
    expect(named.skipped[0]!.why).toContain("addresses, not names");
    const cidr = compile(
      rules({ rule: [{ id: "u.c", action: "deny", match: { cidr: ["10.0.0.0/8"] } }] }),
      "enforce",
    );
    expect(cidr.skipped[0]!.why).toContain("single addresses");
  });
  test("when the user has an allow rule, denies are reported instead of enforced in the kernel", () => {
    const r = rules({
      rule: [
        { id: "u.no-secrets", action: "deny", match: { file: { name: ["secret-*.txt"], ops: ["read"] } } },
      ],
    });
    const c = compile(r, "enforce", { cannotDeny: true });
    expect(c.deny).toEqual([]);
    expect(c.report).toHaveLength(1);
  });
  test("every clause compiled from the presets is accepted by the profile builder", () => {
    for (const mode of ["monitor", "enforce"] as const) {
      const c = compile(preset(), mode);
      const p = {
        ...defaultPolicy(["/work/proj"], "/work/scratch", {}, HOME),
        reportClauses: c.report,
        denyClauses: c.deny,
      };
      expect(() => seatbeltProfile(p)).not.toThrow();
    }
  });
});

describe("a clause cannot change the profile around it", () => {
  test("accepts one balanced form of the right kind", () => {
    expect(checkClause('(allow file-read* (subpath "/x") (with report))', "allow")).toContain(
      "(allow file-read*",
    );
    expect(checkClause('(deny network-outbound (remote ip "*:80"))', "deny")).toContain("(deny");
  });
  test.each([
    ["(allow default)\n(deny file-read*)", "allow"],
    ['(deny file-read* (subpath "/x"))', "allow"],
    ['(allow file-read* (subpath "/x")) (allow default)', "allow"],
    ['(allow file-read* (subpath "/x")', "allow"],
    ['(allow file-read* (subpath "/x"))) (allow default', "allow"],
  ])("refuses %j", (c, verb) => expect(() => checkClause(c, verb as "allow")).toThrow(GrantError));
  test("a paren inside a string does not count", () => {
    expect(() => checkClause('(allow file-read* (subpath "/a)b(c"))', "allow")).not.toThrow();
  });
});

describe("reading the sandbox's log", () => {
  test("denials, reports and the shapes of each operation", () => {
    const p = parseSandboxLine;
    expect(
      p(
        "2026-11-11 15:33:39.940 E  kernel[0:3f6e46] (Sandbox) Sandbox: cat(36917) deny(1) file-read-data /private/tmp/sv-trace-lQmj/denied/f",
      ),
    ).toEqual({
      proc: "cat",
      pid: 36917,
      verdict: "deny",
      op: "file-read-data",
      target: "/private/tmp/sv-trace-lQmj/denied/f",
    });
    expect(
      p("kernel[0:3f931e] (Sandbox) Sandbox: curl(37458) allow network-outbound remote:*:18765"),
    ).toMatchObject({ proc: "curl", verdict: "allow", op: "network-outbound", target: "remote:*:18765" });
    expect(p("(Sandbox) Sandbox: sh(37456) allow process-exec* /bin/bash")).toMatchObject({
      op: "process-exec*",
      target: "/bin/bash",
    });
    expect(p("(Sandbox) Sandbox: Google Chrome He(401) deny(1) mach-lookup com.apple.x")).toMatchObject({
      proc: "Google Chrome He",
      op: "mach-lookup",
    });
    expect(
      p("(Sandbox) 5 duplicate reports for Sandbox: mds(367) deny(1) system-info vfs.disk-space"),
    ).toMatchObject({ proc: "mds" }); // still a sandbox line
    expect(p("some other log line")).toBeNull();
  });
});

describe("what was observed is judged by the same rules", () => {
  const ev = (o: Partial<Observed>): Observed => ({
    pid: 1,
    proc: "python3",
    verdict: "allow",
    op: "file-read-data",
    target: "/work/proj/.env",
    ...o,
  });
  const ctx = { cwd: "/work/proj", home: HOME, production: [] as string[] };
  test("a read of .env matches the same rule as `cat .env` would", () => {
    const f = evaluateObserved([ev({})], preset(), ctx);
    expect(f).toEqual([
      expect.objectContaining({ ruleId: "balanced.env-files", action: "ask", blocked: false }),
    ]);
  });
  test("a denied operation is marked blocked", () => {
    const f = evaluateObserved([ev({ verdict: "deny", target: "/home/u/.ssh/id_rsa" })], preset(), ctx);
    expect(f[0]).toMatchObject({ ruleId: "balanced.credential-files", action: "deny", blocked: true });
  });
  test("writes, deletes and permission changes are told apart", () => {
    const r = rules({
      rule: [
        { id: "u.w", action: "deny", match: { file: { under: ["/etc"], ops: ["write"] } } },
        { id: "u.d", action: "ask", match: { file: { under: ["/data"], ops: ["delete"] } } },
      ],
    });
    expect(evaluateObserved([ev({ op: "file-write-create", target: "/etc/x" })], r, ctx)[0]).toMatchObject({
      ruleId: "u.w",
    });
    expect(evaluateObserved([ev({ op: "file-write-unlink", target: "/data/x" })], r, ctx)[0]).toMatchObject({
      ruleId: "u.d",
    });
    expect(evaluateObserved([ev({ op: "file-read-data", target: "/etc/x" })], r, ctx)).toEqual([]);
  });
  test("network and program operations", () => {
    const r = rules({
      rule: [
        { id: "u.p", action: "deny", match: { port: [8080] } },
        { id: "u.x", action: "ask", match: { program: "base64" } },
      ],
    });
    expect(
      evaluateObserved([ev({ op: "network-outbound", target: "remote:*:8080", proc: "curl" })], r, ctx)[0],
    ).toMatchObject({ ruleId: "u.p" });
    expect(evaluateObserved([ev({ op: "network-outbound", target: "remote:*:443" })], r, ctx)).toEqual([]);
    expect(
      evaluateObserved([ev({ op: "process-exec*", target: "/usr/bin/base64" })], r, ctx)[0],
    ).toMatchObject({ ruleId: "u.x" });
  });
  test("operations no rule speaks about, and repeats, produce nothing extra", () => {
    expect(
      evaluateObserved(
        [ev({ target: "/work/proj/src/a.ts" }), ev({ op: "mach-lookup", target: "x" })],
        preset(),
        ctx,
      ),
    ).toEqual([]);
    expect(evaluateObserved([ev({}), ev({}), ev({ pid: 2 })], preset(), ctx)).toHaveLength(1);
  });
  test("subjects carry what rules look at", () => {
    const s = subjectFor(ev({ target: "/work/proj/.env" }), { cwd: "/work/proj", home: HOME })!;
    expect(s.paths).toEqual([{ path: "/work/proj/.env", ops: ["read"] }]);
    expect(s.capabilities).toEqual(["fs.read", "secret.read"]);
    expect(
      subjectFor(ev({ op: "process-exec*", target: "/usr/local/bin/claude" }), {})!.capabilities,
    ).toContain("agent.spawn");
  });
  test("describing an operation for a receipt", () => {
    expect(describeObserved(ev({}))).toBe("read /work/proj/.env");
    expect(describeObserved(ev({ op: "file-write-unlink", target: "/x" }))).toBe("deleted /x");
    expect(describeObserved(ev({ op: "network-outbound", target: "remote:*:8080" }))).toBe(
      "connected to *:8080",
    );
    expect(describeObserved(ev({ op: "process-exec*", target: "/bin/rm" }))).toBe("started /bin/rm");
  });
});
