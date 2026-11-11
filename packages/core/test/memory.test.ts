import { describe, expect, test } from "bun:test";
import { GlobalStore, type RememberInput, type Where } from "../src/index.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const here: Where = { key: "repo-a", root: "/work/a", worktree: "/work/a" };
const other: Where = { key: "repo-b", root: "/work/b", worktree: "/work/b" };
const sibling: Where = { key: "repo-a", root: "/work/a", worktree: "/work/a-wt" };

function mem() {
  const g = new GlobalStore(":memory:");
  return g.memory;
}
const w = (
  o: Partial<RememberInput> & Pick<RememberInput, "subject" | "predicate" | "object">,
): RememberInput => ({
  writer: "user",
  at: T0,
  ...o,
});

describe("predicate vocabulary and slot drift", () => {
  test("aliases and near spellings land on one canonical predicate", () => {
    const m = mem();
    const a = m.remember(w({ subject: "api", predicate: "test cmd", object: "bun test" }), here);
    expect(a.status).toBe("added");
    if (a.status !== "added") throw 0;
    expect(a.fact.predicate).toBe("test_command");
    expect(a.notes.join(" ")).toContain("stored as test_command");
    // another spelling of the same slot restates, it does not add a row
    const b = m.remember(w({ subject: "api", predicate: "Tests run with", object: "bun test" }), here);
    expect(b.status).toBe("restated");
    const c = m.remember(w({ subject: "api", predicate: "test-command", object: "bun test" }), here);
    expect(c.status).toBe("restated");
    expect(m.active(here)).toHaveLength(1);
  });

  test("a typo of a known predicate resolves by similarity", () => {
    const m = mem();
    expect(m.resolvePredicate("package manger")).toEqual({ canonical: "package_manager", how: "similar" });
    expect(m.resolvePredicate("zzz unrelated")).toEqual({ canonical: "zzz_unrelated", how: "new" });
  });

  test("a subject spelled differently joins the existing one", () => {
    const m = mem();
    m.remember(w({ subject: "API server", predicate: "database", object: "postgres" }), here);
    const r = m.remember(w({ subject: "the api-server", predicate: "framework", object: "hono" }), here);
    if (r.status !== "added") throw new Error(r.status);
    expect(r.fact.subject).toBe("API server");
    expect(r.notes.join(" ")).toContain('matches existing "API server"');
  });

  test("an unknown predicate is created multi-valued and reported by review", () => {
    const m = mem();
    const r = m.remember(w({ subject: "api", predicate: "ci provider", object: "buildkite" }), here);
    if (r.status !== "added") throw new Error(r.status);
    expect(r.notes.join(" ")).toContain("new predicate ci_provider");
    expect(m.review(here).newPredicates).toEqual([{ predicate: "ci_provider", count: 1, closeTo: null }]);
  });
});

describe("two timelines and supersession", () => {
  test("a single-valued predicate: a new value closes the old, nothing is deleted", () => {
    const m = mem();
    m.remember(w({ subject: "api", predicate: "package_manager", object: "npm" }), here);
    const r = m.remember(
      w({ subject: "api", predicate: "package_manager", object: "bun", at: T0 + DAY }),
      here,
    );
    if (r.status !== "added") throw new Error(r.status);
    expect(r.closed).toHaveLength(1);
    const old = m.get(r.closed[0]!.id)!;
    expect(old.object).toBe("npm");
    expect(old.invalidAt).toBe(T0 + DAY); // stopped being true
    expect(old.expiredAt).toBe(T0 + DAY); // stopped being believed
    expect(old.validAt).toBe(T0); // it was true from when it was said
    expect(m.active(here).map((f) => f.object)).toEqual(["bun"]);
    expect(m.history(here, "api", "package_manager").map((f) => f.object)).toEqual(["bun", "npm"]);
  });

  test("a multi-valued predicate keeps both values", () => {
    const m = mem();
    m.remember(w({ subject: "api", predicate: "framework", object: "hono" }), here);
    m.remember(w({ subject: "api", predicate: "framework", object: "zod" }), here);
    expect(m.active(here).map((f) => f.object)).toEqual(["hono", "zod"]);
  });

  test("restating a fact adds no row, and raises its trust if the restater is more trusted", () => {
    const m = mem();
    m.remember(w({ subject: "me", predicate: "editor", object: "helix", writer: "rule" }), here);
    const r = m.remember(w({ subject: "me", predicate: "editor", object: "Helix", writer: "user" }), here);
    expect(r.status).toBe("restated");
    expect(m.counts()).toEqual({ active: 1, closed: 0 });
    expect(m.active(here)[0]!.trust).toBe("asserted");
  });

  test("retracting closes the fact and says so when there is nothing to retract", () => {
    const m = mem();
    m.remember(w({ subject: "api", predicate: "framework", object: "hono" }), here);
    const gone = m.remember(
      w({ subject: "api", predicate: "framework", object: "hono", retract: true, at: T0 + 5 }),
      here,
    );
    expect(gone.status).toBe("retracted");
    expect(m.active(here)).toHaveLength(0);
    expect(m.counts()).toEqual({ active: 0, closed: 1 });
    const none = m.remember(
      w({ subject: "api", predicate: "framework", object: "express", retract: true }),
      here,
    );
    expect(none.status).toBe("refused");
  });
});

describe("trust", () => {
  test("an agent cannot assert what the user did not say", () => {
    const m = mem();
    const r = m.remember(
      w({
        subject: "me",
        predicate: "prefers",
        object: "tabs",
        writer: "agent",
        trust: "asserted",
        userWords: ["fix the build"],
      }),
      here,
    );
    if (r.status !== "added") throw new Error(r.status);
    expect(r.fact.trust).toBe("observed");
    expect(r.notes.join(" ")).toContain("cannot be asserted");
  });

  test("an agent's asserted claim stands when the value is in the user's own words", () => {
    const m = mem();
    const r = m.remember(
      w({
        subject: "me",
        predicate: "prefers",
        object: "tabs",
        writer: "agent",
        trust: "asserted",
        userWords: ["I always prefer Tabs over spaces"],
      }),
      here,
    );
    if (r.status !== "added") throw new Error(r.status);
    expect(r.fact.trust).toBe("asserted");
  });

  test("a model never gets above inferred; a rule never above observed", () => {
    const m = mem();
    const a = m.remember(
      w({ subject: "x", predicate: "note", object: "one", writer: "model", trust: "asserted" }),
      here,
    );
    const b = m.remember(
      w({ subject: "x", predicate: "note", object: "two", writer: "rule", trust: "asserted" }),
      here,
    );
    if (a.status !== "added" || b.status !== "added") throw 0;
    expect([a.fact.trust, b.fact.trust]).toEqual(["inferred", "observed"]);
  });

  test("less trusted information does not replace a more trusted single value", () => {
    const m = mem();
    m.remember(w({ subject: "api", predicate: "database", object: "postgres" }), here);
    const r = m.remember(
      w({ subject: "api", predicate: "database", object: "mysql", writer: "model" }),
      here,
    );
    expect(r.status).toBe("kept");
    expect(m.active(here).map((f) => f.object)).toEqual(["postgres"]);
  });
});

describe("scopes", () => {
  test("a codebase predicate cannot be wider than its repo", () => {
    const m = mem();
    const r = m.remember(
      w({ subject: "api", predicate: "test_command", object: "bun test", scope: "everywhere" }),
      here,
    );
    if (r.status !== "added") throw new Error(r.status);
    expect(r.fact.scope).toBe("repo");
    expect(r.notes.join(" ")).toContain("kept to this repo");
  });

  test("facts are visible only where their scope reaches", () => {
    const m = mem();
    m.remember(
      w({ subject: "me", predicate: "prefers", object: "short answers", scope: "everywhere" }),
      here,
    );
    m.remember(w({ subject: "api", predicate: "database", object: "postgres", scope: "repo" }), here);
    m.remember(
      w({ subject: "api", predicate: "note", object: "local checkout only", scope: "project" }),
      here,
    );
    m.remember(w({ subject: "api", predicate: "note", object: "this branch only", scope: "worktree" }), here);
    const names = (x: Where) => m.active(x).map((f) => f.object);
    expect(names(here)).toEqual(["short answers", "postgres", "local checkout only", "this branch only"]);
    expect(names(sibling)).toEqual(["short answers", "postgres", "local checkout only"]); // other worktree, same repo
    expect(names(other)).toEqual(["short answers"]);
  });

  test("a narrower scope wins for a single-valued predicate", () => {
    const m = mem();
    m.remember(w({ subject: "api", predicate: "package_manager", object: "npm", scope: "repo" }), here);
    m.remember(w({ subject: "api", predicate: "package_manager", object: "bun", scope: "worktree" }), here);
    expect(m.active(here).map((f) => f.object)).toEqual(["bun"]);
    expect(m.active(sibling).map((f) => f.object)).toEqual(["npm"]);
  });
});

describe("what is never stored", () => {
  test("a credential is refused, not masked into a fact", () => {
    const m = mem();
    const key = `${"sk"}_live_${"Ab12Cd34Ef56Gh78"}`;
    const r = m.remember(w({ subject: "stripe", predicate: "note", object: `the key is ${key}` }), here);
    expect(r.status).toBe("refused");
    expect(m.counts().active).toBe(0);
  });

  test("empty and oversized facts are refused with the limit named", () => {
    const m = mem();
    expect(m.remember(w({ subject: "", predicate: "note", object: "x" }), here).status).toBe("refused");
    const big = m.remember(w({ subject: "a", predicate: "note", object: "x".repeat(501) }), here);
    expect(big.status === "refused" && big.reason).toContain("object 500");
  });
});

describe("reading", () => {
  test("the core block is asserted facts only, at most 8, and identical whenever it is asked", () => {
    const m = mem();
    for (let i = 0; i < 10; i++)
      m.remember(
        w({ subject: "me", predicate: "prefers", object: `thing ${i}`, scope: "everywhere", at: T0 + i }),
        here,
      );
    m.remember(w({ subject: "me", predicate: "avoids", object: "unconfirmed", writer: "rule" }), here);
    const a = m.core(here);
    expect(a).toHaveLength(8);
    expect(a.every((f) => f.trust === "asserted")).toBe(true);
    expect(JSON.stringify(m.core(here))).toBe(JSON.stringify(a));
  });

  test("relevant facts: only those sharing a word with the request, newer first", () => {
    const m = mem();
    m.remember(
      w({ subject: "deploy", predicate: "note", object: "staging uses blue green releases", at: T0 }),
      here,
    );
    m.remember(
      w({
        subject: "deploy",
        predicate: "note",
        object: "staging database is reset nightly",
        at: T0 + 60 * DAY,
      }),
      here,
    );
    m.remember(
      w({ subject: "me", predicate: "prefers", object: "short commit messages", at: T0 + 60 * DAY }),
      here,
    );
    const got = m.relevant(here, "why is the staging database empty?", T0 + 61 * DAY).map((f) => f.object);
    expect(got[0]).toBe("staging database is reset nightly");
    expect(got).toContain("staging uses blue green releases");
    expect(got).not.toContain("short commit messages");
    expect(m.relevant(here, "completely unrelated words here", T0 + 61 * DAY)).toEqual([]);
  });

  test("recency halves every 30 days and use raises rank", () => {
    const m = mem();
    m.remember(
      w({ subject: "lib", predicate: "note", object: "cache invalidation rules old", at: T0 }),
      here,
    );
    m.remember(
      w({ subject: "lib", predicate: "note", object: "cache invalidation rules new", at: T0 + 30 * DAY }),
      here,
    );
    const at = T0 + 31 * DAY;
    expect(m.relevant(here, "cache invalidation", at)[0]!.object).toContain("new");
    const old = m.active(here).find((f) => f.object.endsWith("old"))!;
    for (let i = 0; i < 5000; i++) m.touch([old], at);
    expect(m.relevant(here, "cache invalidation", at)[0]!.object).toContain("old"); // heavy use outweighs age
  });

  test("recall counts uses and filters by subject", () => {
    const m = mem();
    m.remember(w({ subject: "api", predicate: "database", object: "postgres" }), here);
    m.remember(w({ subject: "web", predicate: "database", object: "none" }), here);
    const got = m.recall(here, { subject: "API" }, T0);
    expect(got.map((f) => f.object)).toEqual(["postgres"]);
    expect(m.get(got[0]!.id)!.uses).toBe(1);
  });
});

describe("review and prune", () => {
  test("near-duplicates and different-predicate duplicates are listed", () => {
    const m = mem();
    m.remember(w({ subject: "api", predicate: "note", object: "deploys every friday afternoon" }), here);
    m.remember(w({ subject: "api", predicate: "note", object: "deploys every friday afternoons" }), here);
    m.remember(w({ subject: "api", predicate: "prefers", object: "bun" }), here);
    m.remember(w({ subject: "api", predicate: "avoids", object: "bun" }), here);
    const reasons = m.review(here).duplicates.map((d) => d.reason);
    expect(reasons.some((r) => r.startsWith("same predicate, near-identical"))).toBe(true);
    expect(reasons).toContain("different predicates, same value");
  });

  test("unconfirmed facts are listed; prune removes only closed facts older than the cutoff", () => {
    const m = mem();
    m.remember(w({ subject: "a", predicate: "framework", object: "hono", writer: "rule" }), here);
    m.remember(w({ subject: "a", predicate: "database", object: "pg" }), here);
    m.remember(w({ subject: "a", predicate: "database", object: "mysql", at: T0 + DAY }), here);
    expect(m.review(here).unconfirmed.map((f) => f.object)).toEqual(["hono"]);
    expect(m.prune(T0 + DAY)).toBe(0); // closed exactly at the cutoff: kept
    expect(m.prune(T0 + 2 * DAY)).toBe(1);
    expect(m.counts()).toEqual({ active: 2, closed: 0 });
  });
});

describe("files a fact mentions", () => {
  test("relative paths in the value are noted; urls, versions and absolute paths are not", () => {
    const m = mem();
    const r = (object: string) => {
      const x = m.remember(w({ subject: "api", predicate: "note", object }), here);
      if (x.status !== "added") throw new Error(x.status);
      return x.fact.files;
    };
    expect(r("retry logic lives in src/net/retry.ts and config.toml")).toEqual([
      "src/net/retry.ts",
      "config.toml",
    ]);
    expect(r("see https://example.com/docs/index.html for details")).toEqual([]);
    expect(r("needs node 20.11.1 or newer")).toEqual([]);
    expect(r("edit /etc/hosts.conf by hand")).toEqual([]);
    expect(r("the e.g. case and i.e. case")).toEqual([]);
  });

  test("core and relevant can leave out facts a caller marks stale", () => {
    const m = mem();
    m.remember(
      w({ subject: "api", predicate: "note", object: "limits are set in src/limits.ts for login" }),
      here,
    );
    m.remember(
      w({ subject: "api", predicate: "note", object: "login limits also documented in the wiki" }),
      here,
    );
    const keep = (f: { files: string[] }) => f.files.length === 0;
    expect(m.relevant(here, "login limits", T0 + 1, 5, new Set(), keep)).toHaveLength(1);
    expect(m.relevant(here, "login limits", T0 + 1)).toHaveLength(2);
    expect(m.core(here, 8, keep)).toHaveLength(2 - 1);
  });
});
