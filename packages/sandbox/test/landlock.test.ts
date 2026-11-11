import { describe, expect, test } from "bun:test";
import { defaultPolicy, describe as describeLevel, landlockArgs, landlockHelper } from "../src/index.ts";

describe("the Landlock helper path (never run on Linux)", () => {
  test("it is off unless the user opts in, and needs the helper binary", () => {
    expect(landlockHelper({})).toBeNull();
    expect(
      landlockHelper({ SIEVE_SANDBOX_HELPER: "1", SIEVE_SANDBOX_HELPER_BIN: "/no/such/helper" }),
    ).toBeNull();
    expect(landlockHelper({ SIEVE_SANDBOX_HELPER: "1", SIEVE_SANDBOX_HELPER_BIN: process.execPath })).toBe(
      process.execPath,
    );
  });

  test("arguments: system folders read-only, project and scratch writable, no home, network off by default", () => {
    const p = defaultPolicy(["/work/proj"], "/tmp/scratch", {}, "/home/me");
    const a = landlockArgs(p, ["sh", "-c", "ls"], () => true);
    expect(a).toContain("--no-net");
    expect(a.slice(a.indexOf("--rw"), a.indexOf("--rw") + 4)).toEqual([
      "--rw",
      p.project[0]!,
      "--rw",
      p.scratch,
    ]); // real paths, as Landlock needs
    expect(a.slice(-4)).toEqual(["--", "sh", "-c", "ls"]);
    expect(a.filter((x) => x === "/home/me" || x.startsWith("/home"))).toEqual([]);
    expect(a).toContain("/usr");
    const net = landlockArgs(
      defaultPolicy(["/work/proj"], "/tmp/s", { network: true }, "/home/me"),
      ["x"],
      () => true,
    );
    expect(net).not.toContain("--no-net");
  });

  test("the receipt says home is closed, not that credential folders are denied", () => {
    const p = defaultPolicy(["/w"], "/tmp/s", {}, "/home/me");
    expect(
      describeLevel({
        kind: "landlock",
        writes: "project + scratch only",
        network: "off",
        env: "allowlist",
        reads: "system folders and the project only (home is closed)",
        limits: "x",
      }),
    ).toContain("landlock · writes: project + scratch only · network: off");
    void p;
  });
});
