import dns from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import { htmlToMarkdown } from "@sieve/core";

/**
 * `sieve_index { url }`: fetch one web page and index it. The only feature that reaches out on the
 * model's behalf, so it is off unless `[fetch] enabled = true`, and strict:
 *  - https only, port 443, no credentials in the URL, a host NAME (never an IP literal), no
 *    internal-looking names, and `allow_hosts` if you set it;
 *  - the name is resolved here, EVERY address must be on the public internet (so one private answer
 *    among several refuses the lot), and the connection goes to the address that was checked, with
 *    the name used only for TLS and the Host header (so a second lookup cannot give another answer);
 *  - redirects (at most 5) are followed by hand and every hop repeats all of the above;
 *  - text only, at most `max_kb`, no compression, a total time limit, no cookies, no headers of yours.
 * The page text is untrusted: it is archived and searched like any output, never executed or obeyed.
 * ADR 0019.
 */

export interface FetchConfig {
  enabled: boolean;
  allow_hosts: string[];
  max_kb: number;
  timeout_ms: number;
}

export type FetchErrorCode =
  | "scheme"
  | "userinfo"
  | "port"
  | "ip-literal"
  | "host-not-allowed"
  | "dns"
  | "private-address"
  | "redirects"
  | "status"
  | "type"
  | "encoding"
  | "timeout"
  | "network";

export class FetchError extends Error {
  constructor(
    readonly code: FetchErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ── addresses ────────────────────────────────────────────────────────────────────────────────

const V4_DENY: Array<[number, number]> = [
  [0x00000000, 8], // this network
  [0x0a000000, 8], // private
  [0x64400000, 10], // carrier-grade NAT
  [0x7f000000, 8], // loopback
  [0xa9fe0000, 16], // link-local, including the cloud metadata address
  [0xac100000, 12], // private
  [0xc0000000, 24], // IETF protocol assignments
  [0xc0000200, 24], // documentation
  [0xc0586300, 24], // 6to4 relay anycast
  [0xc0a80000, 16], // private
  [0xc6120000, 15], // benchmarking
  [0xc6336400, 24], // documentation
  [0xcb007100, 24], // documentation
  [0xe0000000, 4], // multicast
  [0xf0000000, 4], // reserved, and the broadcast address
];

function v4(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  let n = 0;
  for (const part of m.slice(1)) {
    if (part.length > 1 && part.startsWith("0")) return null; // 010.0.0.1 is read differently by different parsers
    const x = Number(part);
    if (x > 255) return null;
    n = n * 256 + x;
  }
  return n;
}

function publicV4(n: number): boolean {
  for (const [base, bits] of V4_DENY) {
    const size = 2 ** (32 - bits);
    if (n >= base && n < base + size) return false;
  }
  return true;
}

/** Eight 16-bit groups, or null if it is not a plain IPv6 address (zone ids are refused). */
function v6(ip: string): number[] | null {
  if (!ip.includes(":") || ip.includes("%")) return null;
  let tail: number[] = [];
  let s = ip;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const n = v4(dotted[1]!);
    if (n === null) return null;
    tail = [n >>> 16, n & 0xffff];
    s = `${s.slice(0, -dotted[1]!.length)}0:0`; // placeholder groups, replaced below
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (x: string) => (x === "" ? [] : x.split(":"));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 && fill < 1) return null;
  const groups = [...head, ...(halves.length === 2 ? Array(fill).fill("0") : []), ...rest];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    out.push(Number.parseInt(g, 16));
  }
  if (dotted) {
    out[6] = tail[0]!;
    out[7] = tail[1]!;
  }
  return out;
}

/**
 * Is this an address on the public internet? Fails closed: anything that is not a well-formed
 * address, or not clearly global, is no. IPv6 forms that embed an IPv4 address (mapped, NAT64, 6to4)
 * are judged by the address inside them.
 */
export function isPublicAddress(ip: string): boolean {
  const four = v4(ip);
  if (four !== null) return publicV4(four);
  const g = v6(ip);
  if (!g) return false;
  const embedded = (hi: number, lo: number) => publicV4(((hi << 16) | lo) >>> 0);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return embedded(g[6]!, g[7]!); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g[6]!, g[7]!); // NAT64
  if ((g[0]! & 0xe000) !== 0x2000) return false; // only global unicast 2000::/3 passes
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!); // 6to4
  if (g[0] === 0x2001 && g[1]! < 0x0200) return false; // Teredo and IETF protocol assignments
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  return true;
}

// ── URLs ─────────────────────────────────────────────────────────────────────────────────────

const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".lan"];

/** Everything about a URL that can be judged without the network. Throws FetchError. */
export function checkUrl(raw: string, cfg: FetchConfig): { url: URL; host: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchError("scheme", `Not a valid URL: ${raw.slice(0, 80)}`);
  }
  if (url.protocol !== "https:")
    throw new FetchError("scheme", `Only https:// URLs are fetched (this one is ${url.protocol}//).`);
  if (url.username || url.password)
    throw new FetchError("userinfo", "A URL with a user name or password in it is not fetched.");
  if (url.port && url.port !== "443")
    throw new FetchError("port", `Only the default https port is used (this URL says ${url.port}).`);
  const bare = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare))
    throw new FetchError(
      "ip-literal",
      "Give a host name, not an IP address: Sieve checks where a name points.",
    );
  const host = bare.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || host === "localhost" || INTERNAL_SUFFIXES.some((s) => host.endsWith(s)))
    throw new FetchError(
      "host-not-allowed",
      `${host} looks like an internal name; Sieve fetches public sites only.`,
    );
  if (cfg.allow_hosts.length) {
    const ok = cfg.allow_hosts.some((a) => {
      const p = a.toLowerCase();
      return p.startsWith("*.") ? host.endsWith(p.slice(1)) : host === p;
    });
    if (!ok)
      throw new FetchError(
        "host-not-allowed",
        `${host} is not in [fetch] allow_hosts (${cfg.allow_hosts.join(", ")}).`,
      );
  }
  return { url, host };
}

// ── the fetch ────────────────────────────────────────────────────────────────────────────────

export interface RequestOpts {
  /** The address that was checked: connect to this, not to the name. */
  ip: string;
  /** For TLS (SNI and certificate check) and the Host header only. */
  hostname: string;
  path: string;
  maxBytes: number;
  signal: AbortSignal;
  /** Called once the response headers have arrived: the address is alive, so its attempt timer stops. */
  onHeaders?: () => void;
  /** Tests only (a local server, its own CA): fetchPage never sets these, and nothing in config can. */
  port?: number;
  ca?: string;
}
export interface RawResponse {
  status: number;
  /** Lower-case names. */
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
}
export interface FetchDeps {
  resolve(host: string): Promise<string[]>;
  request(o: RequestOpts): Promise<RawResponse>;
}

export interface Page {
  /** The final URL without query or fragment (both can hold tokens): what the archive records as the source. */
  source: string;
  kind: "html" | "text";
  text: string;
  bytes: number;
  truncated: boolean;
  redirects: number;
}

export const realDeps: FetchDeps = {
  resolve: async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address),
  request: (o) =>
    new Promise<RawResponse>((resolve, reject) => {
      const req = https.request(
        {
          host: o.ip,
          port: o.port ?? 443,
          ...(o.ca ? { ca: o.ca } : {}),
          servername: o.hostname,
          method: "GET",
          path: o.path,
          signal: o.signal,
          rejectUnauthorized: true,
          headers: {
            Host: o.hostname,
            "User-Agent": "sieve-index/0.1",
            Accept: "text/html,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.1",
            "Accept-Encoding": "identity",
          },
        },
        (res) => {
          o.onHeaders?.();
          const chunks: Buffer[] = [];
          let n = 0;
          let truncated = false;
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers))
              headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : (v ?? "");
            resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks), truncated });
          };
          res.on("data", (c: Buffer) => {
            if (n + c.length > o.maxBytes) {
              chunks.push(c.subarray(0, o.maxBytes - n));
              n = o.maxBytes;
              truncated = true;
              res.destroy();
              finish();
              return;
            }
            n += c.length;
            chunks.push(c);
          });
          res.on("end", finish);
          res.on("close", finish);
          res.on("error", (e) => (truncated ? finish() : reject(e)));
        },
      );
      req.on("error", reject);
      req.end();
    }),
};

/**
 * Ask the checked addresses in turn. One that does not answer within its share of the time (seen
 * with the compiled binary: the first of two addresses hung while the second took 91 ms) or refuses
 * the connection is skipped for the next, which was validated like the rest before any attempt. An
 * HTTP answer, even an error, is final: nothing is retried on another address, and once the headers
 * arrive only the whole-fetch limit applies.
 */
async function requestAny(
  deps: FetchDeps,
  host: string,
  addrs: string[],
  path: string,
  cfg: FetchConfig,
  signal: AbortSignal,
): Promise<RawResponse> {
  const attemptMs = Math.max(1000, Math.min(5000, Math.ceil(cfg.timeout_ms / 3)));
  let last = "no address answered";
  for (const ip of addrs) {
    const attempt = new AbortController();
    const onAbort = () => attempt.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stall = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        attempt.abort();
        reject(new Error(`no answer from ${ip} within ${attemptMs / 1000} s`));
      }, attemptMs);
    });
    try {
      return await Promise.race([
        deps.request({
          ip,
          hostname: host,
          path,
          maxBytes: cfg.max_kb * 1024,
          signal: attempt.signal,
          // An answer means the address is alive: from here only the whole-fetch limit applies, so a
          // slow body is not mistaken for a dead address and retried elsewhere.
          onHeaders: () => clearTimeout(timer),
        }),
        stall,
      ]);
    } catch (e) {
      if (e instanceof FetchError || signal.aborted) throw e;
      last = (e as Error).message;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
  throw new FetchError("network", `Could not fetch ${host}: ${last}`);
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

function classify(contentType: string): "html" | "text" | null {
  const t = contentType.split(";")[0]!.trim().toLowerCase();
  if (t === "text/html" || t === "application/xhtml+xml") return "html";
  if (
    t.startsWith("text/") ||
    t === "application/json" ||
    t === "application/xml" ||
    t === "application/yaml" ||
    t === "application/x-ndjson" ||
    t.endsWith("+json") ||
    t.endsWith("+xml")
  )
    return "text";
  return null;
}

function decode(body: Buffer, contentType: string): string {
  const cs = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  try {
    // an unknown label throws, and the catch falls back to UTF-8
    return new TextDecoder((cs ?? "utf-8") as ConstructorParameters<typeof TextDecoder>[0]).decode(body);
  } catch {
    return body.toString("utf8");
  }
}

/** Fetch one page under the policy above. Throws FetchError; never returns a response it should not have fetched. */
export async function fetchPage(raw: string, cfg: FetchConfig, deps: FetchDeps = realDeps): Promise<Page> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new FetchError("timeout", `No complete answer within ${Math.round(cfg.timeout_ms / 1000)} s.`));
    }, cfg.timeout_ms);
  });
  const run = async (): Promise<Page> => {
    let current = raw;
    let redirects = 0;
    for (;;) {
      const { url, host } = checkUrl(current, cfg);
      let addrs: string[];
      try {
        addrs = await deps.resolve(host);
      } catch {
        throw new FetchError("dns", `Could not resolve ${host}.`);
      }
      if (!addrs.length) throw new FetchError("dns", `Could not resolve ${host}.`);
      for (const a of addrs)
        if (!isPublicAddress(a))
          throw new FetchError(
            "private-address",
            `${host} points at an address that is not on the public internet (${a}); Sieve will not connect to it.`,
          );
      const res = await requestAny(deps, host, addrs, url.pathname + url.search, cfg, ctl.signal);
      if (REDIRECTS.has(res.status)) {
        const to = res.headers.location;
        if (!to) throw new FetchError("status", `${host} answered ${res.status} with no Location.`);
        if (++redirects > MAX_REDIRECTS)
          throw new FetchError("redirects", `More than ${MAX_REDIRECTS} redirects.`);
        try {
          current = new URL(to, url).toString();
        } catch {
          throw new FetchError("scheme", "A redirect pointed at something that is not a URL.");
        }
        continue;
      }
      if (res.status < 200 || res.status >= 300)
        throw new FetchError("status", `${host} answered ${res.status}.`);
      const enc = (res.headers["content-encoding"] ?? "").trim().toLowerCase();
      if (enc && enc !== "identity")
        throw new FetchError("encoding", `${host} sent a ${enc}-compressed page; Sieve asked for none.`);
      const ctype = res.headers["content-type"] ?? "";
      const kind = classify(ctype);
      if (!kind)
        throw new FetchError(
          "type",
          `${host} sent ${ctype.split(";")[0] || "no content type"}; Sieve indexes text pages only.`,
        );
      if (res.body.subarray(0, 8192).includes(0)) throw new FetchError("type", `${host} sent binary data.`);
      return {
        source: `${url.origin}${url.pathname}`,
        kind,
        text: decode(res.body, ctype),
        bytes: res.body.length,
        truncated: res.truncated,
        redirects,
      };
    }
  };
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The text to index for a fetched page: HTML becomes readable Markdown, anything else is kept as sent. */
export function pageText(p: Page): string {
  return p.kind === "html" ? htmlToMarkdown(p.text).md : p.text;
}
