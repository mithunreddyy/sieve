import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  bwrapArgs,
  checkWritable,
  credentialPaths,
  defaultPolicy,
  describe as describeLevel,
  detect,
  ENV_ALLOWLIST,
  filterEnv,
  GrantError,
  seatbeltProfile,
  wrap,
} from "../src/index.ts";

const policy = (over: Record<string, unknown> = {}) => ({
  ...defaultPolicy(["/work/proj"], "/work/scratch"),
  ...over,
});

describe("Seatbelt profile", () => {
  test("denies network and writes first, then allows only the project, scratch and grants", () => {
    const p = seatbeltProfile({ ...policy(), writable: ["/work/extra"], denyRead: ["/home/u/.ssh"] });
    const lines = p.split("\n");
    expect(lines[0]).toBe("(version 1)");
    expect(lines).toContain("(deny network*)");
    expect(lines).toContain("(deny file-write*)");
    const allow = lines.find((l) => l.startsWith("(allow file-write* (subpath"))!;
    expect(allow).toBe(
      '(allow file-write* (subpath "/work/proj") (subpath "/work/scratch") (subpath "/work/extra"))',
    );
    // Later rules win in Seatbelt: every deny precedes the allow for writes.
    expect(lines.indexOf("(deny file-write*)")).toBeLessThan(lines.indexOf(allow));
    expect(p).toContain('(deny file-read* (subpath "/home/u/.ssh"))');
  });
  test("network on removes the network deny, and nothing else changes", () => {
    const off = seatbeltProfile(policy({ network: false })).split("\n");
    const on = seatbeltProfile(policy({ network: true })).split("\n");
    expect(off.filter((l) => !on.includes(l))).toEqual(["(deny network*)"]);
  });
  test("a path that could break out of the profile is refused", () => {
    expect(() => seatbeltProfile(policy({ writable: ['/x") (allow default) ("'] }))).toThrow(GrantError);
    expect(() => seatbeltProfile(policy({ writable: ["/x\nnewline"] }))).toThrow(GrantError);
  });
});

describe("bubblewrap command line", () => {
  test("read-only root, writable binds for the project/scratch/grants, no network, credential folders hidden", () => {
    const a = bwrapArgs(
      {
        ...policy(),
        writable: ["/work/extra"],
        denyRead: ["/home/u/.ssh", "/home/u/.npmrc", "/home/u/.absent"],
      },
      ["bash", "/work/scratch/script.sh"],
      "/work/proj",
      (p) => !p.endsWith(".absent"),
    );
    expect(a).toContain("--unshare-net");
    expect(a.slice(a.indexOf("--ro-bind"), a.indexOf("--ro-bind") + 3)).toEqual(["--ro-bind", "/", "/"]);
    for (const w of ["/work/proj", "/work/scratch", "/work/extra"])
      expect(a.join(" ")).toContain(`--bind ${w} ${w}`);
    expect(a.join(" ")).not.toContain(".absent");
    expect(a.slice(a.indexOf("--chdir"))).toEqual([
      "--chdir",
      "/work/proj",
      "--",
      "bash",
      "/work/scratch/script.sh",
    ]);
    expect(a).toContain("--die-with-parent");
  });
  test("network on leaves the network namespace alone", () => {
    expect(bwrapArgs(policy({ network: true }), ["true"], "/", () => false)).not.toContain("--unshare-net");
  });
});

describe("environment allowlist", () => {
  const base = {
    PATH: "/bin",
    HOME: "/h",
    OPENAI_API_KEY: "k1",
    AWS_SECRET_ACCESS_KEY: "k2",
    NPM_TOKEN: "k3",
    LANG: "C",
  };
  test("API keys and tokens are removed; a grant by name passes one through", () => {
    expect(filterEnv(base)).toEqual({ PATH: "/bin", HOME: "/h", LANG: "C" });
    expect(filterEnv(base, ["NPM_TOKEN"])).toEqual({ PATH: "/bin", HOME: "/h", LANG: "C", NPM_TOKEN: "k3" });
  });
  test("the allowlist itself holds nothing that looks like a credential", () => {
    expect(ENV_ALLOWLIST.filter((n) => /KEY|TOKEN|SECRET|PASS|CRED/i.test(n))).toEqual([]);
  });
});

describe("grants are checked", () => {
  const home = homedir();
  test("refuses the home folder, system folders and credential locations", () => {
    for (const bad of [
      "/",
      home,
      "/etc",
      "/usr/local",
      join(home, ".ssh"),
      join(home, ".aws", "x"),
      "/System/Library",
    ])
      expect(() => checkWritable(bad)).toThrow(GrantError);
  });
  test("accepts a folder inside the home folder, and a temp path", () => {
    expect(() => checkWritable(join(home, ".cache", "sieve-test"))).not.toThrow();
    expect(() => checkWritable("/tmp/sieve-test-x")).not.toThrow();
  });
  test("credential locations include the usual suspects", () => {
    const c = credentialPaths("/h");
    for (const p of [".ssh", ".aws", ".gnupg", ".npmrc", ".netrc", ".git-credentials"])
      expect(c).toContain(`/h/${p}`);
  });
});

describe("wrap and describe", () => {
  const base = { PATH: process.env.PATH, SECRET_THING: "x" };
  test("mode off runs the command as given and says why there is no isolation", () => {
    const w = wrap(["bash", "s.sh"], "/work/proj", policy(), base, { A: "1" }, "off");
    expect([w.cmd, ...w.args]).toEqual(["bash", "s.sh"]);
    expect(w.env.SECRET_THING).toBe("x"); // unsandboxed: the whole environment, as before
    expect(describeLevel(w.level)).toBe(
      "none (sandbox turned off in config; code runs as you, with full file and network access)",
    );
  });
  test("a sandboxed level states exactly what is enforced and what is not", () => {
    const w = wrap(
      ["bash", "s.sh"],
      "/work/proj",
      policy({ network: true, networkHosts: ["registry.npmjs.org"], env: ["NPM_TOKEN"] }),
      base,
      {},
      "auto",
    );
    if (detect().kind === "none") return;
    const d = describeLevel(w.level);
    expect(d).toContain(detect().kind);
    expect(d).toContain("network: on (all hosts; hosts registry.npmjs.org requested, not filtered)");
    expect(d).toContain("env: allowlist + NPM_TOKEN");
    expect(d).toContain("memory and process counts are not limited");
    expect(w.env.SECRET_THING).toBeUndefined();
  });
  test("require with no backend refuses instead of running unisolated", () => {
    if (detect().kind !== "none") return;
    expect(() => wrap(["true"], "/", policy(), base, {}, "require")).toThrow(GrantError);
  });
});
