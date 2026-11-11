import { randomBytes, timingSafeEqual } from "node:crypto";
import { collect, original } from "./data.ts";
import { PAGE } from "./page.ts";

/**
 * `sieve dash`: a local web page over the databases. It listens on 127.0.0.1 only, and wants
 * a random token (in the URL it prints, then a cookie) and a Host header naming the loopback
 * address, so another website cannot read it through your browser (DNS rebinding) and another
 * local user does not get it by guessing the port.
 */

export interface Dash {
  url: string;
  token: string;
  port: number;
  stop(): void;
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function serveDashboard(opts: { port?: number } = {}): Dash {
  const token = randomBytes(16).toString("hex");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    fetch(req) {
      const url = new URL(req.url);
      const host = req.headers.get("host") ?? "";
      if (!new RegExp(`^(127\\.0\\.0\\.1|localhost):${server.port}$`).test(host))
        return new Response("wrong host", { status: 403 });
      const cookie = /(?:^|;\s*)sieve_dash=([0-9a-f]+)/.exec(req.headers.get("cookie") ?? "")?.[1] ?? "";
      const given = url.searchParams.get("t") ?? "";
      const authed = same(cookie, token);
      if (!authed && !same(given, token)) return new Response("token required", { status: 401 });
      const headers: Record<string, string> = {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
        "referrer-policy": "no-referrer",
      };
      if (!authed) headers["set-cookie"] = `sieve_dash=${token}; HttpOnly; SameSite=Strict; Path=/`;
      if (url.pathname === "/")
        return new Response(PAGE, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
      if (url.pathname === "/api/snapshot") return Response.json(collect(), { headers });
      if (url.pathname === "/api/original") {
        const o = original(url.searchParams.get("p") ?? "", url.searchParams.get("id") ?? "");
        return o
          ? new Response(o.text, { headers: { ...headers, "content-type": "text/plain; charset=utf-8" } })
          : new Response("not archived", { status: 404, headers });
      }
      return new Response("not found", { status: 404, headers });
    },
  });
  return {
    port: server.port ?? 0,
    token,
    url: `http://127.0.0.1:${server.port}/?t=${token}`,
    stop: () => server.stop(true),
  };
}
