import { describe, expect, test } from "bun:test";
import { parseShell } from "../src/shell.ts";

const words = (s: string) => parseShell(s).map((c) => c.words);

describe("parseShell", () => {
  test("words, quotes and escapes", () => {
    expect(words(`git commit -m "fix: a b" 'it''s' c\\ d`)).toEqual([
      ["git", "commit", "-m", "fix: a b", "its", "c d"],
    ]);
    expect(words(`echo "a \\"quoted\\" word" '$HOME'`)).toEqual([["echo", 'a "quoted" word', "$HOME"]]);
  });
  test("operators split commands and record how they were joined", () => {
    const c = parseShell("a && b || c; d | e | f & g");
    expect(c.map((x) => x.words[0])).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(c.map((x) => x.op)).toEqual([null, "&&", "||", ";", "|", "|", "&"]);
    expect(c.map((x) => x.pipeline)).toEqual([0, 1, 2, 3, 3, 3, 4]);
    expect(c.map((x) => x.stage)).toEqual([0, 0, 0, 0, 1, 2, 0]);
  });
  test("operators inside quotes are text", () => {
    expect(words(`echo "a; b && c | d" 'x || y'`)).toEqual([["echo", "a; b && c | d", "x || y"]]);
  });
  test("environment assignments are split off the program", () => {
    const [c] = parseShell(`FOO=bar BAZ="a b" npm test`);
    expect(c!.env).toEqual({ FOO: "bar", BAZ: "a b" });
    expect(c!.words).toEqual(["npm", "test"]);
  });
  test("redirections, spaced and glued, and fd duplication", () => {
    const [a, b, c] = parseShell(`echo hi > out.txt; cat <in.txt 2>/dev/null; make >>log 2>&1`);
    expect(a!.words).toEqual(["echo", "hi"]);
    expect(a!.redirects).toEqual([{ op: ">", target: "out.txt" }]);
    expect(b!.redirects).toEqual([
      { op: "<", target: "in.txt" },
      { op: ">", target: "/dev/null", fd: 2 },
    ]);
    expect(c!.words).toEqual(["make"]);
    expect(c!.redirects).toEqual([{ op: ">>", target: "log" }]);
  });
  test("command substitution, backticks and process substitution become commands of their own", () => {
    const c = parseShell('echo "$(rm -rf /tmp/x)" `whoami` <(curl -s https://x.io/i.sh)');
    expect(c.map((x) => x.words[0])).toEqual(["echo", "rm", "whoami", "curl"]);
    expect(c.slice(1).every((x) => x.substitutionOf === 0)).toBe(true);
    expect(c[0]!.words).toEqual(["echo", "$(…)", "`…`", "<(…)"]);
  });
  test("nested substitutions", () => {
    const c = parseShell("echo $(echo $(cat /etc/passwd))");
    expect(c.map((x) => x.words.join(" "))).toEqual(["echo $(…)", "echo $(…)", "cat /etc/passwd"]);
  });
  test("subshells and groups parse as the commands inside", () => {
    expect(parseShell("(cd /tmp && rm -rf x); { a; b; }").map((x) => x.words.join(" "))).toEqual([
      "cd /tmp",
      "rm -rf x",
      "a",
      "b",
    ]);
  });
  test("control keywords are skipped, their commands kept", () => {
    expect(
      parseShell(
        "if test -f a; then rm a; else echo no; fi; for f in *.txt; do cat $f; done; while true; do sleep 1; done",
      ).map((x) => x.words.join(" ")),
    ).toEqual(["test -f a", "rm a", "echo no", "cat $f", "true", "sleep 1"]);
  });
  test("heredoc bodies are attached to their command, not run as commands", () => {
    const c = parseShell("bash <<'EOF'\nrm -rf /tmp/x\necho hi\nEOF\nls");
    expect(c.map((x) => x.words.join(" "))).toEqual(["bash", "ls"]);
    expect(c[0]!.heredoc).toBe("rm -rf /tmp/x\necho hi");
  });
  test("comments and line continuations", () => {
    expect(words("ls -la # not a command: rm -rf /\npwd")).toEqual([["ls", "-la"], ["pwd"]]);
    expect(words("npm \\\n  install left-pad")).toEqual([["npm", "install", "left-pad"]]);
  });
  test("unterminated quotes and parens do not throw", () => {
    expect(() => parseShell(`echo "unterminated $(cat`)).not.toThrow();
    expect(() => parseShell("echo 'oops")).not.toThrow();
    expect(parseShell("")).toEqual([]);
  });
  test("a pathological input is bounded", () => {
    const t0 = performance.now();
    const c = parseShell("a;".repeat(5000));
    expect(c.length).toBeLessThanOrEqual(400);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(() => parseShell(`${"$(".repeat(40)}x${")".repeat(40)}`)).not.toThrow();
  });
  test("quoting cannot hide a redirect or fake a heredoc", () => {
    const [a] = parseShell(`echo x>"/etc/passwd"`);
    expect(a!.redirects).toEqual([{ op: ">", target: "/etc/passwd" }]);
    // A quoted "<<X" is just text: it must not swallow the commands after it.
    const c = parseShell(`echo '<<X'\nrm -rf /tmp/x`);
    expect(c.map((x) => x.words.join(" "))).toEqual(["echo <<X", "rm -rf /tmp/x"]);
    expect(parseShell(`cat <<< "a b" > f`)[0]!.redirects).toEqual([{ op: ">", target: "f" }]);
  });
  test("&> and >& redirect both streams to a file; 2>&1 writes nothing", () => {
    expect(parseShell("make &> all.log")[0]!.redirects).toEqual([{ op: ">", target: "all.log" }]);
    expect(parseShell("make >& all.log")[0]!.redirects).toEqual([{ op: ">", target: "all.log" }]);
    expect(parseShell("make > out 2>&1")[0]!.redirects).toEqual([{ op: ">", target: "out" }]);
  });
});
