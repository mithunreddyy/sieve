import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IndexArgs, PROTOCOL_VERSION, TOOLS, type ToolResult } from "@sieve/protocol";
import { Daemon } from "../src/index.ts";
import type { FetchDeps, RawResponse } from "../src/webfetch.ts";
import { freshHome } from "./helpers.ts";

let env: ReturnType<typeof freshHome>;
let project: string;
beforeAll(() => {
  env = freshHome();
  project = join(env.home, "proj");
  mkdirSync(project);
});
afterAll(() => env.cleanup());

const PUB = "93.184.216.34";
function fakeWeb(pages: Record<string, string>) {
  const log: string[] = [];
  const deps: FetchDeps = {
    resolve: async () => [PUB],
    request: async (o): Promise<RawResponse> => {
      log.push(`${o.ip} ${o.hostname}${o.path}`);
      const body = pages[`${o.hostname}${o.path}`];
      return body === undefined
        ? { status: 404, headers: {}, body: Buffer.alloc(0), truncated: false }
        : {
            status: 200,
            headers: { "content-type": "text/html" },
            body: Buffer.from(body),
            truncated: false,
          };
    },
  };
  return { deps, log };
}

async function start(config: string, deps?: FetchDeps) {
  writeFileSync(join(env.home, "config.toml"), config);
  const d = new Daemon({
    idleMinutes: 0,
    socketPath: join(env.home, `${Math.random().toString(36).slice(2, 8)}.sock`),
    lockPath: join(env.home, `${Math.random().toString(36).slice(2, 8)}.lock`),
    log: () => {},
  });
  if (deps) d.ctx.fetchDeps = deps;
  expect(await d.start()).toBe(true);
  const call = async (tool: string, args: unknown) => {
    const r = await d.handleLine(
      JSON.stringify({ v: PROTOCOL_VERSION, id: "t", type: "tool", tool, args, cwd: project }),
    );
    if (!r.ok) return { ok: false as const, text: r.error.message };
    const res = r.result as ToolResult;
    return { ok: !res.isError, text: res.content };
  };
  return { d, call };
}

const PAGE =
  "<html><head><title>Rate limits</title></head><body><main><h1>Rate limits</h1><p>The widget endpoint allows zebrafish quotas of 40 requests per minute.</p></main></body></html>";

describe("sieve_index with a url", () => {
  test("is off by default: it says so, and nothing is fetched", async () => {
    const w = fakeWeb({ "docs.example.com/rate": PAGE });
    const { d, call } = await start("", w.deps);
    try {
      const r = await call("sieve_index", { url: "https://docs.example.com/rate" });
      expect(r.ok).toBe(false);
      expect(r.text).toContain("off");
      expect(r.text).toContain("[fetch]");
      expect(w.log).toEqual([]);
    } finally {
      await d.stop();
    }
  });

  test("on: the page is fetched from the checked address, indexed as readable text, and found by search", async () => {
    const w = fakeWeb({ "docs.example.com/rate?key=SECRETISH": PAGE });
    const { d, call } = await start("[fetch]\nenabled = true\n", w.deps);
    try {
      const r = await call("sieve_index", { url: "https://docs.example.com/rate?key=SECRETISH#top" });
      expect(r.ok).toBe(true);
      expect(w.log).toEqual([`${PUB} docs.example.com/rate?key=SECRETISH`]);
      expect(r.text).toContain("https://docs.example.com/rate");
      expect(r.text).not.toContain("SECRETISH"); // the query can hold a token: never echoed or stored
      expect(r.text).toContain("untrusted");
      const hit = await call("sieve_search", { query: "zebrafish quotas" });
      expect(hit.text).toContain("zebrafish");
      expect(hit.text).toContain("docs.example.com/rate");
      expect(hit.text).not.toContain("SECRETISH");
      expect(hit.text).not.toContain("<html"); // indexed as Markdown, not markup
    } finally {
      await d.stop();
    }
  });

  test("a URL the policy refuses reports why, and never reaches the transport", async () => {
    const w = fakeWeb({});
    const { d, call } = await start("[fetch]\nenabled = true\n", w.deps);
    try {
      for (const [url, why] of [
        ["http://docs.example.com/", "https"],
        ["https://127.0.0.1/", "host name"],
        ["https://localhost/", "internal"],
        ["https://user:pw@docs.example.com/", "password"],
      ] as const) {
        const r = await call("sieve_index", { url });
        expect(r.ok).toBe(false);
        expect(r.text).toContain(why);
      }
      expect(w.log).toEqual([]);
    } finally {
      await d.stop();
    }
  });

  test("allow_hosts limits it", async () => {
    const w = fakeWeb({ "docs.example.com/rate": PAGE, "other.example.net/x": PAGE });
    const { d, call } = await start('[fetch]\nenabled = true\nallow_hosts = ["docs.example.com"]\n', w.deps);
    try {
      expect((await call("sieve_index", { url: "https://other.example.net/x" })).ok).toBe(false);
      expect((await call("sieve_index", { url: "https://docs.example.com/rate" })).ok).toBe(true);
      expect(w.log).toEqual([`${PUB} docs.example.com/rate`]);
    } finally {
      await d.stop();
    }
  });

  test("Guard is consulted first, and a deny means no fetch", async () => {
    const w = fakeWeb({ "docs.example.com/rate": PAGE });
    const { d, call } = await start("[fetch]\nenabled = true\n", w.deps);
    try {
      let asked: unknown;
      (d.ctx.guard as any).evaluate = (e: unknown) => {
        asked = e;
        return { decision: { action: "deny" }, action: "deny", message: "blocked by a rule" };
      };
      const r = await call("sieve_index", { url: "https://docs.example.com/rate" });
      expect(r.ok).toBe(false);
      expect(r.text).toContain("blocked by a rule");
      expect(w.log).toEqual([]);
      expect(JSON.stringify(asked)).toContain("docs.example.com"); // Guard saw the host
    } finally {
      await d.stop();
    }
  });

  test("a real Guard deny rule on a host stops the fetch, and other hosts still work", async () => {
    const w = fakeWeb({ "docs.example.com/rate": PAGE, "x.blocked.example.com/p": PAGE });
    writeFileSync(
      join(env.home, "guard.toml"),
      [
        'mode = "enforce"',
        "[[rule]]",
        'id = "t.no-blocked-host"',
        'action = "deny"',
        'reason = "That site is off limits."',
        "[rule.match]",
        'capability = ["net.fetch"]',
        'host = ["*.blocked.example.com"]',
        "[[rule.test]]",
        'command = "curl https://x.blocked.example.com/"',
        'expect = "deny"',
        "",
      ].join("\n"),
    );
    const { d, call } = await start("[fetch]\nenabled = true\n", w.deps);
    try {
      const blocked = await call("sieve_index", { url: "https://x.blocked.example.com/p" });
      expect(blocked.ok).toBe(false);
      expect(blocked.text).toContain("That site is off limits.");
      expect(w.log).toEqual([]); // never resolved, never connected
      expect((await call("sieve_index", { url: "https://docs.example.com/rate" })).ok).toBe(true);
      expect(w.log).toEqual([`${PUB} docs.example.com/rate`]);
    } finally {
      await d.stop();
      writeFileSync(join(env.home, "guard.toml"), "");
    }
  });

  test("a fetch error is a message, not a crash", async () => {
    const w = fakeWeb({});
    const { d, call } = await start("[fetch]\nenabled = true\n", w.deps);
    try {
      const r = await call("sieve_index", { url: "https://docs.example.com/missing" });
      expect(r.ok).toBe(false);
      expect(r.text).toContain("404");
    } finally {
      await d.stop();
    }
  });
});

describe("the tool's schema", () => {
  test("exactly one of path, content or url; unknown fields are still rejected by name", () => {
    expect(IndexArgs.safeParse({ url: "https://a.example.com/" }).success).toBe(true);
    expect(IndexArgs.safeParse({ url: "https://a.example.com/", path: "x" }).success).toBe(false);
    expect(IndexArgs.safeParse({ url: "https://a.example.com/", content: "x" }).success).toBe(false);
    expect(IndexArgs.safeParse({}).success).toBe(false);
    expect(IndexArgs.safeParse({ url: "https://a.example.com/", cookie: "x" }).success).toBe(false);
    expect(IndexArgs.safeParse({ url: "not a url" }).success).toBe(false);
  });
  test("the description says it is off by default, and stays under 400 characters", () => {
    const d = TOOLS.sieve_index.description;
    expect(d.length).toBeLessThan(400);
    expect(d.toLowerCase()).toContain("url");
    expect(d.toLowerCase()).toContain("off");
  });
});
