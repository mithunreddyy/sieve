import { describe, expect, test } from "bun:test";
import {
  checkUrl,
  type FetchConfig,
  type FetchDeps,
  FetchError,
  fetchPage,
  isPublicAddress,
  type RawResponse,
} from "../src/webfetch.ts";

/**
 * `sieve_index { url }` is the one feature that reaches out, so its policy is tested without the
 * network: addresses and URLs as pure functions, and the whole fetch against an injected transport
 * that records what it was asked to connect to. (Off unless `[fetch] enabled = true`.)
 */

const CFG: FetchConfig = { enabled: true, allow_hosts: [], max_kb: 64, timeout_ms: 2000 };
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "no error";
  } catch (e) {
    return e instanceof FetchError ? e.code : `other: ${e}`;
  }
};

describe("which addresses are public", () => {
  test.each([
    "93.184.216.34",
    "8.8.8.8",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
  ])("%s is public", (ip) => expect(isPublicAddress(ip)).toBe(true));

  test.each([
    ["127.0.0.1", "loopback"],
    ["127.1.2.3", "loopback range"],
    ["10.0.0.1", "private 10/8"],
    ["172.16.0.1", "private 172.16/12"],
    ["172.31.255.255", "end of 172.16/12"],
    ["192.168.1.1", "private 192.168/16"],
    ["169.254.169.254", "cloud metadata (link-local)"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["0.0.0.0", "unspecified"],
    ["0.1.2.3", "this network"],
    ["224.0.0.1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
    ["192.0.0.1", "IETF protocol assignments"],
    ["198.18.0.1", "benchmarking"],
    ["192.0.2.1", "documentation"],
    ["::1", "IPv6 loopback"],
    ["::", "IPv6 unspecified"],
    ["fe80::1", "IPv6 link-local"],
    ["fc00::1", "IPv6 unique local"],
    ["fd12:3456:789a::1", "IPv6 unique local"],
    ["ff02::1", "IPv6 multicast"],
    ["2001:db8::1", "IPv6 documentation"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:7f00:1", "IPv4-mapped loopback, hex form"],
    ["::ffff:10.0.0.1", "IPv4-mapped private"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
    ["64:ff9b::7f00:1", "NAT64 embedding loopback"],
    ["64:ff9b::a9fe:a9fe", "NAT64 embedding metadata"],
    ["2002:7f00:1::1", "6to4 embedding loopback"],
    ["2002:a9fe:a9fe::1", "6to4 embedding metadata"],
    ["not-an-ip", "not an address: fail closed"],
    ["", "empty: fail closed"],
    ["999.1.1.1", "malformed"],
  ])("%s is not public (%s)", (ip) => expect(isPublicAddress(ip)).toBe(false));
});

describe("which URLs are acceptable at all", () => {
  test.each([
    ["http://example.com/", "scheme"],
    ["ftp://example.com/", "scheme"],
    ["file:///etc/passwd", "scheme"],
    ["javascript:alert(1)", "scheme"],
    ["https://user:pw@example.com/", "userinfo"],
    ["https://user@example.com/", "userinfo"],
    ["https://example.com:8443/", "port"],
    ["https://example.com:80/", "port"],
    ["https://127.0.0.1/", "ip-literal"],
    ["https://[::1]/", "ip-literal"],
    ["https://8.8.8.8/", "ip-literal"],
    ["https://0x7f.1/", "ip-literal"], // the URL parser reads this as 127.0.0.1
    ["https://2130706433/", "ip-literal"], // decimal form of 127.0.0.1
    ["https://localhost/", "host-not-allowed"],
    ["https://app.localhost/", "host-not-allowed"],
    ["https://printer.local/", "host-not-allowed"],
    ["https://metadata.google.internal/", "host-not-allowed"],
    ["https://intranet/", "host-not-allowed"], // a single-label name is an internal name
    ["not a url", "scheme"],
  ])("%s is refused (%s)", (url, why) => {
    try {
      checkUrl(url, CFG);
      throw new Error("was accepted");
    } catch (e) {
      expect((e as FetchError).code).toBe(why as FetchError["code"]);
    }
  });

  test("a plain https URL is accepted and its host lowercased", () => {
    expect(checkUrl("https://Docs.Example.COM/a/b?x=1#y", CFG).host).toBe("docs.example.com");
  });

  test("allow_hosts: exact names and *.suffix, nothing else", () => {
    const cfg = { ...CFG, allow_hosts: ["docs.example.com", "*.example.org"] };
    expect(checkUrl("https://docs.example.com/", cfg).host).toBe("docs.example.com");
    expect(checkUrl("https://a.b.example.org/", cfg).host).toBe("a.b.example.org");
    for (const bad of [
      "https://example.com/",
      "https://evil-docs.example.com.attacker.net/",
      "https://example.org/",
      "https://notexample.org/",
    ])
      expect(() => checkUrl(bad, cfg)).toThrow(FetchError);
  });
});

type Page = Omit<Partial<RawResponse>, "body"> & { body?: string };

/** An injected transport: a table of host → addresses, and of "ip|path" → response. */
function world(dns: Record<string, string[]>, pages: Record<string, Page>) {
  const calls: Array<{ ip: string; hostname: string; path: string }> = [];
  const resolved: string[] = [];
  const deps: FetchDeps = {
    resolve: async (h) => {
      resolved.push(h);
      const a = dns[h];
      if (!a) throw new Error("ENOTFOUND");
      return a;
    },
    request: async (o) => {
      calls.push({ ip: o.ip, hostname: o.hostname, path: o.path });
      const p = pages[`${o.hostname}${o.path}`];
      if (!p) return { status: 404, headers: {}, body: Buffer.alloc(0), truncated: false };
      const body = Buffer.from(p.body ?? "");
      const cut = body.length > o.maxBytes;
      return {
        status: p.status ?? 200,
        headers: { "content-type": "text/html", ...(p.headers ?? {}) },
        body: cut ? body.subarray(0, o.maxBytes) : body,
        truncated: cut,
      };
    },
  };
  return { deps, calls, resolved };
}
const PUB = "93.184.216.34";

describe("fetchPage", () => {
  test("connects to the address it validated, with the host name only for TLS and the Host header", async () => {
    const w = world(
      { "example.com": [PUB] },
      {
        "example.com/page?token=abc": {
          body: "<html><title>T</title><body><main><h1>Hello</h1><p>World</p></main></body></html>",
        },
      },
    );
    const p = await fetchPage("https://example.com/page?token=abc#frag", CFG, w.deps);
    expect(w.calls).toEqual([{ ip: PUB, hostname: "example.com", path: "/page?token=abc" }]);
    expect(p.kind).toBe("html");
    expect(p.text).toContain("Hello");
    // what is stored as the source never carries the query or fragment (they can hold tokens)
    expect(p.source).toBe("https://example.com/page");
    expect(p.source).not.toContain("token");
  });

  test("one private address among the answers refuses the lot (mixed DNS answers)", async () => {
    const w = world({ "example.com": [PUB, "10.0.0.5"] }, { "example.com/": { body: "x" } });
    expect(await code(fetchPage("https://example.com/", CFG, w.deps))).toBe("private-address");
    expect(w.calls).toEqual([]); // nothing was connected to
  });

  test.each([
    ["loopback", "127.0.0.1"],
    ["metadata", "169.254.169.254"],
    ["mapped loopback", "::ffff:127.0.0.1"],
  ])("a public-looking name that resolves to %s is refused before any connection", async (_n, ip) => {
    const w = world({ "evil.example.com": [ip] }, { "evil.example.com/": { body: "x" } });
    expect(await code(fetchPage("https://evil.example.com/", CFG, w.deps))).toBe("private-address");
    expect(w.calls).toEqual([]);
  });

  test("a name that does not resolve is a dns error, not a crash", async () => {
    const w = world({}, {});
    expect(await code(fetchPage("https://nowhere.example.com/", CFG, w.deps))).toBe("dns");
  });

  describe("when an address does not answer (seen in the compiled binary: the first of two hung while the second took 91 ms)", () => {
    const ok = (body = "ok"): RawResponse => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: Buffer.from(body),
      truncated: false,
    });
    const SECOND = "93.184.216.35";

    test("a stalled address is skipped for the next one, which was checked too", async () => {
      const tried: string[] = [];
      const deps: FetchDeps = {
        resolve: async () => [PUB, SECOND],
        request: (o) => {
          tried.push(o.ip);
          return o.ip === PUB ? new Promise<RawResponse>(() => {}) : Promise.resolve(ok());
        },
      };
      const t0 = Date.now();
      const p = await fetchPage("https://example.com/", { ...CFG, timeout_ms: 3000 }, deps);
      expect(p.text).toBe("ok");
      expect(tried).toEqual([PUB, SECOND]);
      expect(Date.now() - t0).toBeLessThan(2500); // an attempt gets a share of the time, not all of it
    });

    test("a refused connection is skipped too", async () => {
      const tried: string[] = [];
      const deps: FetchDeps = {
        resolve: async () => [PUB, SECOND],
        request: async (o) => {
          tried.push(o.ip);
          if (o.ip === PUB) throw new Error("ECONNREFUSED");
          return ok();
        },
      };
      expect((await fetchPage("https://example.com/", CFG, deps)).text).toBe("ok");
      expect(tried).toEqual([PUB, SECOND]);
    });

    test("once the headers arrive the per-address timer stops: a slow body is not mistaken for a dead address", async () => {
      const tried: string[] = [];
      const deps: FetchDeps = {
        resolve: async () => [PUB, SECOND],
        request: async (o) => {
          tried.push(o.ip);
          o.onHeaders?.(); // the server answered; the body is simply slow
          await Bun.sleep(1500); // longer than one address's share of a 3 s budget
          return ok("slow but complete");
        },
      };
      const p = await fetchPage("https://example.com/", { ...CFG, timeout_ms: 3000 }, deps);
      expect(p.text).toBe("slow but complete");
      expect(tried).toEqual([PUB]); // the first address was kept: it had answered
    });

    test("but the whole fetch is still bounded: a body that never ends times out", async () => {
      const deps: FetchDeps = {
        resolve: async () => [PUB],
        request: (o) => {
          o.onHeaders?.();
          return new Promise<RawResponse>(() => {});
        },
      };
      const t0 = Date.now();
      expect(await code(fetchPage("https://example.com/", { ...CFG, timeout_ms: 1500 }, deps))).toBe(
        "timeout",
      );
      expect(Date.now() - t0).toBeLessThan(3500);
    });

    test("every address failing is one network error that names the host", async () => {
      const deps: FetchDeps = {
        resolve: async () => [PUB, SECOND],
        request: async () => {
          throw new Error("ECONNRESET");
        },
      };
      const e = await fetchPage("https://example.com/", CFG, deps).catch((x) => x);
      expect(e).toBeInstanceOf(FetchError);
      expect(e.code).toBe("network");
      expect(e.message).toContain("example.com");
    });

    test("an HTTP answer, even an error, is final: the next address is not asked", async () => {
      const tried: string[] = [];
      const deps: FetchDeps = {
        resolve: async () => [PUB, SECOND],
        request: async (o) => {
          tried.push(o.ip);
          return { status: 503, headers: {}, body: Buffer.alloc(0), truncated: false };
        },
      };
      expect(await code(fetchPage("https://example.com/", CFG, deps))).toBe("status");
      expect(tried).toEqual([PUB]);
    });

    test("a private address among the answers is still refused up front: no attempt is made on any of them", async () => {
      const tried: string[] = [];
      const deps: FetchDeps = {
        resolve: async () => [PUB, "10.1.1.1"],
        request: async (o) => {
          tried.push(o.ip);
          return ok();
        },
      };
      expect(await code(fetchPage("https://example.com/", CFG, deps))).toBe("private-address");
      expect(tried).toEqual([]);
    });
  });

  describe("redirects are checked at every hop", () => {
    const hop = (to: string) => ({ status: 302, headers: { location: to }, body: "" });
    test("to another public host: followed, and the new host is resolved and validated itself", async () => {
      const w = world(
        { "a.example.com": [PUB], "b.example.org": ["93.184.216.35"] },
        { "a.example.com/": hop("https://b.example.org/x"), "b.example.org/x": { body: "<p>landed</p>" } },
      );
      const p = await fetchPage("https://a.example.com/", CFG, w.deps);
      expect(w.resolved).toEqual(["a.example.com", "b.example.org"]);
      expect(w.calls.map((c) => `${c.ip} ${c.hostname}`)).toEqual([
        `${PUB} a.example.com`,
        "93.184.216.35 b.example.org",
      ]);
      expect(p.redirects).toBe(1);
      expect(p.source).toBe("https://b.example.org/x");
    });
    test("a relative Location resolves against the current URL", async () => {
      const w = world(
        { "a.example.com": [PUB] },
        { "a.example.com/dir/": hop("../other"), "a.example.com/other": { body: "<p>ok</p>" } },
      );
      expect((await fetchPage("https://a.example.com/dir/", CFG, w.deps)).source).toBe(
        "https://a.example.com/other",
      );
    });
    test.each([
      ["http:// (downgrade)", "http://b.example.org/", "scheme"],
      ["a literal loopback IP", "https://127.0.0.1/admin", "ip-literal"],
      ["a literal metadata IP", "https://169.254.169.254/latest/meta-data/", "ip-literal"],
      ["a name that resolves to a private address", "https://rebind.example.org/", "private-address"],
      ["localhost", "https://localhost:443/", "host-not-allowed"],
      ["userinfo", "https://u:p@b.example.org/", "userinfo"],
    ])("to %s is refused", async (_n, to, why) => {
      const w = world(
        { "a.example.com": [PUB], "rebind.example.org": ["192.168.0.10"], "b.example.org": [PUB] },
        { "a.example.com/": hop(to) },
      );
      expect(await code(fetchPage("https://a.example.com/", CFG, w.deps))).toBe(why);
      expect(w.calls).toHaveLength(1); // only the first hop was ever connected to
    });
    test("a redirect to a host outside allow_hosts is refused", async () => {
      const cfg = { ...CFG, allow_hosts: ["a.example.com"] };
      const w = world(
        { "a.example.com": [PUB], "b.example.org": [PUB] },
        { "a.example.com/": hop("https://b.example.org/") },
      );
      expect(await code(fetchPage("https://a.example.com/", cfg, w.deps))).toBe("host-not-allowed");
    });
    test("a loop stops after 5 redirects", async () => {
      const w = world({ "a.example.com": [PUB] }, { "a.example.com/": hop("/") });
      expect(await code(fetchPage("https://a.example.com/", CFG, w.deps))).toBe("redirects");
      expect(w.calls).toHaveLength(6); // the first request and 5 redirects
    });
    test("a redirect with no Location is an error", async () => {
      const w = world(
        { "a.example.com": [PUB] },
        { "a.example.com/": { status: 301, headers: {}, body: "" } },
      );
      expect(await code(fetchPage("https://a.example.com/", CFG, w.deps))).toBe("status");
    });
  });

  describe("what comes back", () => {
    const page = (p: Page) => world({ "example.com": [PUB] }, { "example.com/": p });
    test("an error status is reported with the status", async () => {
      const w = page({ status: 503, body: "down" });
      expect(await code(fetchPage("https://example.com/", CFG, w.deps))).toBe("status");
    });
    test("a missing page is a status error too", async () => {
      const w = world({ "example.com": [PUB] }, {});
      await expect(fetchPage("https://example.com/missing", CFG, w.deps)).rejects.toThrow("404");
    });
    test.each(["image/png", "application/pdf", "application/octet-stream", "video/mp4", "application/zip"])(
      "%s is refused: Sieve indexes text",
      async (ct) => {
        const w = page({ headers: { "content-type": ct }, body: "binary" });
        expect(await code(fetchPage("https://example.com/", CFG, w.deps))).toBe("type");
      },
    );
    test.each([
      ["text/plain; charset=utf-8", "text"],
      ["text/markdown", "text"],
      ["application/json", "text"],
      ["application/xml", "text"],
      ["text/html; charset=UTF-8", "html"],
      ["application/xhtml+xml", "html"],
    ])("%s is text (%s)", async (ct, kind) => {
      const w = page({ headers: { "content-type": ct }, body: "<p>hi</p>" });
      expect((await fetchPage("https://example.com/", CFG, w.deps)).kind).toBe(kind as "html" | "text");
    });
    test("a compressed response is refused, not mangled", async () => {
      const w = page({ headers: { "content-type": "text/plain", "content-encoding": "gzip" }, body: "x" });
      expect(await code(fetchPage("https://example.com/", CFG, w.deps))).toBe("encoding");
    });
    test("over max_kb: the first part is kept and it says so", async () => {
      const w = page({ headers: { "content-type": "text/plain" }, body: "x".repeat(100 * 1024) });
      const p = await fetchPage("https://example.com/", CFG, w.deps);
      expect(p.truncated).toBe(true);
      expect(p.bytes).toBe(64 * 1024);
    });
    test("a slow server times out instead of hanging the daemon", async () => {
      const deps: FetchDeps = { resolve: async () => [PUB], request: () => new Promise(() => {}) };
      const t0 = Date.now();
      expect(await code(fetchPage("https://example.com/", { ...CFG, timeout_ms: 1000 }, deps))).toBe(
        "timeout",
      );
      expect(Date.now() - t0).toBeLessThan(3000);
    });
  });
});
