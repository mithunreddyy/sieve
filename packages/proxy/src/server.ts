import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  type Config,
  decideFold,
  GlobalStore,
  loadConfig,
  PROXY_PROJECT,
  ProjectStore,
  paths,
} from "@sieve/core";
import {
  type Archiver,
  type ProxyLimits,
  parseTooLong,
  type Stats,
  transformAnthropic,
  transformGemini,
  transformOpenAI,
} from "./transform.ts";

/**
 * `sieve proxy` (slice 10): a local gateway in front of Anthropic-, OpenAI- and Gemini-shaped
 * APIs. Your client keeps its own key and sends it as usual; the proxy forwards it to the
 * upstream you configured and does not store it. It listens on 127.0.0.1 only.
 *
 * Fail open: if a transform throws, the original bytes are forwarded. If the upstream cannot be
 * reached the client gets a 502, which is the one thing the proxy cannot make up for.
 */

// biome-ignore lint/suspicious/noExplicitAny: provider bodies are open-ended JSON
type Json = any;

export interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

type Provider = "anthropic" | "openai" | "gemini";

interface CallRecord {
  provider: Provider;
  model?: string;
  session: string;
  status: number;
  usage: Usage;
  stats?: Stats;
  retried?: string;
  failedOpen?: string;
}
type Recorder = (r: CallRecord) => void;

const limitsOf = (c: Config["proxy"]): ProxyLimits => ({
  trimDescriptionBytes: c.trim_description_bytes,
  foldResultBytes: c.fold_result_bytes,
  archiveAt: c.archive_at,
  archiveStep: c.archive_step,
  keepRecentMessages: c.keep_recent_messages,
  addCacheMarks: c.add_cache_marks,
  foldHistory: c.fold_history,
  trimTools: c.trim_tools,
});

/** The archive behind the proxy: its own project database, so `sieve_get` can expand what it archived. */
export function proxyArchiver(store: ProjectStore): Archiver {
  const put = (text: string) => {
    const safe = store.mask(text, "");
    return {
      item: store.put(text, {
        masked: safe,
        sessionId: "proxy",
        worktree: "",
        sourceKind: "tool",
        source: "proxy",
      }),
      safe,
    };
  };
  return {
    archive: (text) => put(text).item.id,
    receipt(text, meta) {
      const { item, safe } = put(text);
      const d = decideFold(
        {
          text: safe,
          isError: false,
          ...(meta.tool ? { toolName: meta.tool } : {}),
          ...(meta.command ? { command: meta.command } : {}),
        },
        item,
      );
      return d.kind === "replace" ? { text: d.text, id: item.id } : null;
    },
  };
}

// ------------------------------------------------------------------ usage

export function usageFromJson(provider: Provider, j: Json): Usage | null {
  if (!j || typeof j !== "object") return null;
  if (provider === "anthropic") {
    const u = j.usage ?? j.message?.usage;
    if (!u) return null;
    return {
      input: u.input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
    };
  }
  if (provider === "openai") {
    const u = j.usage;
    if (!u) return null;
    const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      input: Math.max(0, (u.prompt_tokens ?? 0) - cached),
      cacheRead: cached,
      cacheWrite: 0,
      output: u.completion_tokens ?? 0,
    };
  }
  const u = j.usageMetadata;
  if (!u) return null;
  const cached = u.cachedContentTokenCount ?? 0;
  return {
    input: Math.max(0, (u.promptTokenCount ?? 0) - cached),
    cacheRead: cached,
    cacheWrite: 0,
    output: u.candidatesTokenCount ?? 0,
  };
}

/** Collects usage from a stream of server-sent events as they pass through. */
export class UsageScanner {
  private buf = "";
  usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  seen = false;
  constructor(private provider: Provider) {}
  push(chunk: string): void {
    this.buf += chunk;
    for (let i = this.buf.indexOf("\n"); i !== -1; i = this.buf.indexOf("\n")) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        this.merge(JSON.parse(data));
      } catch {}
    }
  }
  private merge(j: Json): void {
    const u = usageFromJson(this.provider, j);
    if (!u) return;
    this.seen = true;
    // Anthropic sends input and cache counts in message_start and the final output count in message_delta.
    if (this.provider === "anthropic") {
      if (j.type === "message_start") this.usage = { ...u };
      else this.usage.output = Math.max(this.usage.output, u.output);
    } else
      this.usage = {
        input: Math.max(this.usage.input, u.input),
        cacheRead: Math.max(this.usage.cacheRead, u.cacheRead),
        cacheWrite: 0,
        output: Math.max(this.usage.output, u.output),
      };
  }
}

export const dollarsFor = (u: Usage, c: Config["proxy"]) =>
  (u.input * c.input_per_mtok +
    u.cacheRead * c.input_per_mtok * 0.1 +
    u.cacheWrite * c.input_per_mtok * 1.25 +
    u.output * c.output_per_mtok) /
  1e6;

// ------------------------------------------------------------------ budgets

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

interface Spend {
  tokens: number;
  dollars: number;
}

function spent(db: Database, since: number, session?: string): Spend {
  const r = db
    .query(
      `SELECT COALESCE(SUM(input_tokens + cache_read + cache_write + output_tokens),0) AS t, COALESCE(SUM(dollars),0) AS d
       FROM proxy_calls WHERE at >= ? ${session ? "AND session = ?" : ""}`,
    )
    .get(...(session ? [since, session] : [since])) as { t: number; d: number };
  return { tokens: r.t, dollars: r.d };
}

export interface BudgetState {
  /** The note to put in front of the model, if a threshold was newly crossed. */
  note: string | null;
  /** Set when a hard stop applies. */
  stop: string | null;
}

export function checkBudget(db: Database, c: Config["proxy"], session: string, now: number): BudgetState {
  const caps = [
    {
      scope: "session",
      key: session,
      what: "tokens",
      cap: c.session_tokens,
      used: () => spent(db, 0, session).tokens,
    },
    {
      scope: "session",
      key: session,
      what: "dollars",
      cap: c.session_dollars,
      used: () => spent(db, 0, session).dollars,
    },
    {
      scope: "day",
      key: String(startOfDay(now)),
      what: "tokens",
      cap: c.day_tokens,
      used: () => spent(db, startOfDay(now)).tokens,
    },
    {
      scope: "day",
      key: String(startOfDay(now)),
      what: "dollars",
      cap: c.day_dollars,
      used: () => spent(db, startOfDay(now)).dollars,
    },
  ];
  let note: string | null = null;
  let stop: string | null = null;
  for (const b of caps) {
    if (!b.cap) continue;
    const pct = Math.floor((b.used() / b.cap) * 100);
    const level = pct >= 100 ? 100 : pct >= 80 ? 80 : pct >= 50 ? 50 : 0;
    const label = `${b.scope === "day" ? "today's" : "this session's"} ${b.what} budget`;
    if (level === 100 && c.hard_stop)
      stop = `Sieve proxy: ${label} is used up (${b.what === "dollars" ? `$${b.cap}` : `${b.cap.toLocaleString("en-US")} tokens`}). Raise it in ~/.sieve/config.toml ([proxy]) or turn off hard_stop.`;
    if (!level) continue;
    const id = `${b.scope}:${b.what}`;
    const already = db
      .query("SELECT 1 FROM proxy_alerts WHERE scope = ? AND key = ? AND pct = ?")
      .get(id, b.key, level);
    if (already) continue;
    db.run("INSERT INTO proxy_alerts (scope, key, pct, at) VALUES (?, ?, ?, ?)", [id, b.key, level, now]);
    note = `[sieve] ${label} is ${level >= 100 ? "used up" : `${level}% used`}.${level >= 100 && !c.hard_stop ? " Requests are still going through (hard_stop is off)." : ""}`;
  }
  return { note, stop };
}

// ------------------------------------------------------------------ the server

export interface Proxy {
  port: number;
  url: string;
  stop(): void;
}

export interface ProxyOptions {
  port?: number;
  config?: Config;
  /** Defaults to the real global database and the proxy archive under the Sieve home. */
  db?: Database;
  archiver?: Archiver;
}

const HOP = new Set([
  "host",
  "content-length",
  "connection",
  "accept-encoding",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
]);

function sessionKey(provider: Provider, body: Json, headers: Headers): string {
  const h = headers.get("x-session-id") ?? headers.get("x-claude-code-session-id");
  if (h) return `h:${h.slice(0, 80)}`;
  const uid = body?.metadata?.user_id;
  if (typeof uid === "string" && uid)
    return `u:${createHash("sha256").update(uid).digest("hex").slice(0, 16)}`;
  const first =
    JSON.stringify(body?.system ?? "").slice(0, 300) +
    JSON.stringify((body?.messages ?? body?.contents ?? [])[0] ?? "").slice(0, 300);
  return `c:${provider}:${createHash("sha256").update(first).digest("hex").slice(0, 16)}`;
}

function addNote(provider: Provider, body: Json, note: string): void {
  if (provider === "anthropic") {
    if (typeof body.system === "string") body.system = `${body.system}\n\n${note}`;
    else if (Array.isArray(body.system)) body.system.push({ type: "text", text: note });
    else body.system = note;
  } else if (provider === "openai") {
    if (Array.isArray(body.messages)) body.messages.unshift({ role: "system", content: note });
  } else {
    body.systemInstruction = { parts: [...(body.systemInstruction?.parts ?? []), { text: note }] };
  }
}

export function startProxy(opts: ProxyOptions = {}): Proxy {
  const config = opts.config ?? loadConfig();
  const pc = config.proxy;
  const gs = opts.db ? null : new GlobalStore(paths.globalDb());
  const db = opts.db ?? gs!.db;
  const archiver = opts.archiver ?? proxyArchiver(new ProjectStore(PROXY_PROJECT));
  const lim = limitsOf(pc);

  const record: Recorder = (r) => {
    try {
      db.run(
        `INSERT INTO proxy_calls (at, provider, model, session, status, input_tokens, cache_read, cache_write, output_tokens,
           trimmed_bytes, folded, archived, marks_added, retried, failed_open, dollars)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          Date.now(),
          r.provider,
          r.model ?? null,
          r.session,
          r.status,
          r.usage.input,
          r.usage.cacheRead,
          r.usage.cacheWrite,
          r.usage.output,
          r.stats?.trimmedBytes ?? 0,
          r.stats?.folded ?? 0,
          r.stats?.archived ?? 0,
          r.stats?.marksAdded ?? 0,
          r.retried ?? null,
          r.failedOpen ?? null,
          dollarsFor(r.usage, pc),
        ],
      );
      for (const s of r.stats?.schemas ?? []) {
        const def = JSON.stringify(s.definition);
        db.run(
          `INSERT INTO proxy_schemas (name, hash, definition, seen_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET hash = excluded.hash, definition = excluded.definition, seen_at = excluded.seen_at`,
          [s.name, createHash("sha256").update(def).digest("hex").slice(0, 16), def, Date.now()],
        );
      }
    } catch {}
  };

  const upstreamFor = (p: Provider) =>
    p === "anthropic" ? pc.anthropic_upstream : p === "openai" ? pc.openai_upstream : pc.gemini_upstream;

  const route = (path: string): Provider | null => {
    if (path === "/v1/messages") return "anthropic";
    if (path === "/v1/chat/completions" || path === "/chat/completions") return "openai";
    if (/^\/v1(beta)?\/models\/[^/]+:(stream)?[gG]enerateContent$/.test(path)) return "gemini";
    return null;
  };

  const headersFor = (req: Request) => {
    const h = new Headers();
    for (const [k, v] of req.headers) if (!HOP.has(k.toLowerCase())) h.set(k, v);
    return h;
  };

  async function send(
    provider: Provider,
    url: URL,
    req: Request,
    body: ArrayBuffer | string,
  ): Promise<Response> {
    const target = new URL(upstreamFor(provider));
    const to = new URL(url.pathname + url.search, target);
    // an upstream with a path prefix (OpenRouter's /api) keeps it
    if (target.pathname !== "/") to.pathname = target.pathname.replace(/\/$/, "") + url.pathname;
    return fetch(to, { method: "POST", headers: headersFor(req), body, redirect: "manual" });
  }

  const server = Bun.serve({
    hostname: pc.host,
    port: opts.port ?? pc.port,
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json({ ok: true, sieve: "proxy" });
      const provider = route(url.pathname);
      if (!provider || req.method !== "POST")
        return Response.json(
          { error: { type: "not_found", message: "sieve proxy: unsupported path" } },
          { status: 404 },
        );
      const raw = await req.arrayBuffer();
      let parsed: Json = null;
      try {
        parsed = JSON.parse(new TextDecoder().decode(raw));
      } catch {}
      if (!parsed || typeof parsed !== "object") {
        // not JSON we understand: forward untouched
        return relay(provider, await send(provider, url, req, raw), undefined, record);
      }
      const session = sessionKey(provider, parsed, req.headers);
      const model: string | undefined = parsed.model ?? url.pathname.match(/models\/([^/:]+)/)?.[1];

      // budgets
      let budgetNote: string | null = null;
      try {
        const b = checkBudget(db, pc, session, Date.now());
        if (b.stop)
          return Response.json(
            { type: "error", error: { type: "rate_limit_error", message: b.stop } },
            { status: 429 },
          );
        budgetNote = b.note;
      } catch {}

      const build = (force = 0, marks = true): { body: Json; stats?: Stats; failedOpen?: string } => {
        try {
          const l = { ...lim, addCacheMarks: lim.addCacheMarks && marks };
          const t =
            provider === "anthropic"
              ? transformAnthropic(parsed, l, archiver, { force })
              : provider === "openai"
                ? transformOpenAI(parsed, l, archiver, { force })
                : transformGemini(parsed, l);
          if (budgetNote) addNote(provider, t.body, budgetNote);
          return { body: t.body, stats: t.stats };
        } catch (e) {
          // fail open: send what the client sent
          const body = structuredClone(parsed);
          if (budgetNote) addNote(provider, body, budgetNote);
          return { body, failedOpen: String((e as Error).message).slice(0, 200) };
        }
      };

      let attempt = build();
      let retried: string | undefined;
      try {
        let res = await send(provider, url, req, JSON.stringify(attempt.body));
        for (let tries = 0; tries < 2 && res.status === 400; tries++) {
          const text = await res.clone().text();
          if (
            !retried?.includes("marks") &&
            provider === "anthropic" &&
            attempt.stats?.marksAdded &&
            /cache_control|breakpoint/i.test(text)
          ) {
            attempt = build(0, false);
            retried = `${retried ? `${retried},` : ""}marks`;
          } else if (!retried?.includes("too-long")) {
            let msg = text;
            try {
              msg = JSON.parse(text)?.error?.message ?? text;
            } catch {}
            const tl = parseTooLong(String(msg));
            if (!tl) break;
            // cut at a fixed boundary: enough old results to clear the limit with a margin
            attempt = build(Math.ceil((tl.actual - tl.limit) * 1.1) + 2000, !retried);
            retried = `${retried ? `${retried},` : ""}too-long`;
          } else break;
          res = await send(provider, url, req, JSON.stringify(attempt.body));
        }
        return relay(
          provider,
          res,
          { model, session, stats: attempt.stats, retried, failedOpen: attempt.failedOpen },
          record,
        );
      } catch (e) {
        // The upstream could not be reached: there is nothing to relay and no way to fail open past that.
        const why = String((e as Error).message).slice(0, 160);
        record({
          provider,
          model,
          session,
          status: 502,
          usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
          failedOpen: `upstream: ${why}`,
        });
        return Response.json(
          {
            type: "error",
            error: {
              type: "api_error",
              message: `sieve proxy: could not reach ${upstreamFor(provider)} (${why})`,
            },
          },
          { status: 502 },
        );
      }
    },
  });

  return {
    port: server.port ?? 0,
    url: `http://127.0.0.1:${server.port}`,
    stop: () => {
      server.stop(true);
      gs?.close();
    },
  };
}

/** Pass the response through as it arrives, reading usage on the way. */
async function relay(
  provider: Provider,
  res: Response,
  meta: { model?: string; session: string; stats?: Stats; retried?: string; failedOpen?: string } | undefined,
  record: Recorder,
): Promise<Response> {
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  const done = (usage: Usage) =>
    meta &&
    record({
      provider,
      model: meta.model,
      session: meta.session,
      status: res.status,
      usage,
      stats: meta.stats,
      retried: meta.retried,
      failedOpen: meta.failedOpen,
    });
  const none: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const type = res.headers.get("content-type") ?? "";
  if (!res.body) {
    done(none);
    return new Response(null, { status: res.status, headers });
  }
  if (type.includes("text/event-stream")) {
    const scan = new UsageScanner(provider);
    const dec = new TextDecoder();
    const t = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, c) {
        c.enqueue(chunk);
        try {
          scan.push(dec.decode(chunk, { stream: true }));
        } catch {}
      },
      flush() {
        done(scan.usage);
      },
    });
    return new Response(res.body.pipeThrough(t), { status: res.status, headers });
  }
  // a JSON body is small enough to read whole
  const buf = new Uint8Array(await res.arrayBuffer());
  let usage = none;
  try {
    usage = usageFromJson(provider, JSON.parse(new TextDecoder().decode(buf))) ?? none;
  } catch {}
  done(usage);
  return new Response(buf, { status: res.status, headers });
}
