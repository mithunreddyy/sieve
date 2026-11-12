import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realDeps } from "../src/webfetch.ts";

/**
 * The real transport (node:https), against a local HTTPS server with a throwaway certificate.
 * Not through fetchPage: its policy refuses loopback, as it must. This checks what the policy
 * relies on: the connection goes to the IP it was given, the certificate is verified against the
 * host NAME (not the IP), and the body is capped.
 */

const dir = mkdtempSync(join(tmpdir(), "sv-tls-"));
function cert(name: string) {
  const key = join(dir, `${name}.key`);
  const crt = join(dir, `${name}.crt`);
  const r = Bun.spawnSync([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    crt,
    "-days",
    "1",
    "-subj",
    `/CN=${name}`,
    "-addext",
    `subjectAltName=DNS:${name}`,
  ]);
  return r.exitCode === 0 ? { key, crt, pem: readFileSync(crt, "utf8") } : null;
}
const good = cert("docs.example.com");
const other = cert("evil.example.net");
/** The CI `offline` job runs the suite in an empty network namespace, where loopback may be down. */
async function loopbackWorks(): Promise<boolean> {
  try {
    const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    try {
      const r = await fetch(`http://127.0.0.1:${s.port}/`, { signal: AbortSignal.timeout(1000) });
      return (await r.text()) === "ok";
    } finally {
      s.stop(true);
    }
  } catch {
    return false;
  }
}
const usable = good && other && (await loopbackWorks());

let server: ReturnType<typeof Bun.serve> | undefined;
let wrong: ReturnType<typeof Bun.serve> | undefined;
const seen: string[] = [];
beforeAll(() => {
  if (!usable) return;
  const handler = (req: Request) => {
    seen.push(
      `${new URL(req.url).pathname} host=${req.headers.get("host")} ae=${req.headers.get("accept-encoding")} ua=${req.headers.get("user-agent")} cookie=${req.headers.get("cookie")}`,
    );
    const path = new URL(req.url).pathname;
    if (path === "/big")
      return new Response("x".repeat(300_000), { headers: { "content-type": "text/plain" } });
    if (path === "/slow") return new Promise<Response>(() => {});
    return new Response("<p>hello</p>", { headers: { "content-type": "text/html" } });
  };
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: Bun.file(good.crt), key: Bun.file(good.key) },
    fetch: handler,
  });
  wrong = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: Bun.file(other.crt), key: Bun.file(other.key) },
    fetch: handler,
  });
});
afterAll(() => {
  server?.stop(true);
  wrong?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const t = usable ? test : test.skip; // no openssl, or no loopback (CI offline job): skipped
const opts = (port: number, ca: string, path = "/") => ({
  ip: "127.0.0.1",
  hostname: "docs.example.com",
  path,
  maxBytes: 64 * 1024,
  signal: new AbortController().signal,
  port,
  ca,
});

describe("the real transport", () => {
  t("connects to the IP it is given and sends the host name as Host, and nothing of the user's", async () => {
    const r = await realDeps.request(opts(server!.port!, good!.pem, "/page?x=1"));
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe("<p>hello</p>");
    expect(r.headers["content-type"]).toBe("text/html");
    const line = seen.at(-1)!;
    expect(line).toContain("/page host=docs.example.com");
    expect(line).toContain("ae=identity");
    expect(line).toContain("ua=sieve-index/0.1");
    expect(line).toContain("cookie=null");
  });

  t(
    "a certificate for another name is refused, even though the IP matches: the name is what is verified",
    async () => {
      await expect(realDeps.request(opts(wrong!.port!, other!.pem))).rejects.toThrow();
    },
  );

  t(
    "without the CA it trusts (a self-signed certificate), the connection fails: no verification is skipped",
    async () => {
      await expect(realDeps.request({ ...opts(server!.port!, ""), ca: undefined })).rejects.toThrow();
    },
  );

  t("a body over the cap is cut at the cap and says so", async () => {
    const r = await realDeps.request(opts(server!.port!, good!.pem, "/big"));
    expect(r.truncated).toBe(true);
    expect(r.body.length).toBe(64 * 1024);
  });

  t("an aborted request ends instead of hanging", async () => {
    const ctl = new AbortController();
    const p = realDeps.request({ ...opts(server!.port!, good!.pem, "/slow"), signal: ctl.signal });
    setTimeout(() => ctl.abort(), 200);
    await expect(p).rejects.toThrow();
  });
});
