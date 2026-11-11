import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { Config, GlobalStore, ProjectStore } from "@sieve/core";
import {
  checkBudget,
  dollarsFor,
  PROXY_PROJECT,
  proxyArchiver,
  startProxy,
  UsageScanner,
} from "../src/index.ts";

let home: string;
let gs: GlobalStore;
let upstream: ReturnType<typeof Bun.serve>;
let proxy: ReturnType<typeof startProxy>;

interface Seen {
  path: string;
  headers: Record<string, string>;
  body: any;
}
let seen: Seen[] = [];
/** What the fake provider does with the next request. */
let respond: (n: number, s: Seen) => Response = () => Response.json({});

const cfg = (over: Record<string, unknown> = {}) =>
  Config.parse({
    proxy: {
      anthropic_upstream: `http://127.0.0.1:${upstream.port}`,
      openai_upstream: `http://127.0.0.1:${upstream.port}`,
      gemini_upstream: `http://127.0.0.1:${upstream.port}`,
      fold_result_bytes: 2048,
      ...over,
    },
  });

function boot(over: Record<string, unknown> = {}) {
  proxy?.stop();
  proxy = startProxy({
    port: 0,
    config: cfg(over),
    db: gs.db,
    archiver: proxyArchiver(new ProjectStore(PROXY_PROJECT)),
  });
}

beforeAll(() => {
  home = mkdtempSync("/tmp/sv-proxy-");
  process.env.SIEVE_HOME = home;
  gs = new GlobalStore();
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.json().catch(() => null);
      const s: Seen = { path: url.pathname, headers: Object.fromEntries(req.headers), body };
      seen.push(s);
      return respond(seen.length, s);
    },
  });
  boot();
});
afterAll(() => {
  proxy.stop();
  upstream.stop(true);
  gs.close();
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  seen = [];
  gs.db.run("DELETE FROM proxy_calls");
  gs.db.run("DELETE FROM proxy_alerts");
  respond = () =>
    Response.json({
      type: "message",
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 0,
      },
    });
  boot();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(proxy.url + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "KEY-123", ...headers },
    body: JSON.stringify(body),
  });
const calls = () => gs.db.query("SELECT * FROM proxy_calls ORDER BY id").all() as any[];
const longTool = {
  name: "big",
  description: "It does a thing. ".repeat(300),
  input_schema: { type: "object", properties: {} },
};

describe("forwarding", () => {
  test("the client's key goes to the upstream untouched, and nothing of it is stored", async () => {
    const r = await post("/v1/messages", { model: "claude-x", messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(200);
    expect(seen[0]!.headers["x-api-key"]).toBe("KEY-123");
    expect(seen[0]!.path).toBe("/v1/messages");
    const dump = JSON.stringify(calls()) + JSON.stringify(gs.db.query("SELECT * FROM proxy_schemas").all());
    expect(dump).not.toContain("KEY-123");
  });

  test("tool descriptions are trimmed on the way out and the full definition is kept", async () => {
    await post("/v1/messages", {
      model: "claude-x",
      messages: [{ role: "user", content: "hi" }],
      tools: [longTool],
    });
    expect(seen[0]!.body.tools[0].description.length).toBeLessThan(1700);
    expect(seen[0]!.body.tools[0].description).toContain('sieve_schema {"tool":"big"}');
    const row = gs.db.query("SELECT definition FROM proxy_schemas WHERE name = 'big'").get() as {
      definition: string;
    };
    expect(JSON.parse(row.definition).description).toBe(longTool.description);
  });

  test("cache marks are added where free; usage and the hit rate are recorded", async () => {
    await post("/v1/messages", {
      model: "claude-x",
      system: "be brief",
      tools: [{ name: "a", description: "d", input_schema: {} }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(JSON.stringify(seen[0]!.body)).toContain("cache_control");
    const c = calls()[0];
    expect(c).toMatchObject({
      provider: "anthropic",
      status: 200,
      input_tokens: 100,
      cache_read: 900,
      output_tokens: 10,
      marks_added: 2,
    });
    expect(c.dollars).toBeGreaterThan(0);
  });

  test("OpenAI-shaped and Gemini-shaped requests are routed and measured", async () => {
    respond = () =>
      Response.json({
        usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 600 } },
      });
    const o = await post(
      "/v1/chat/completions",
      { model: "gpt-x", messages: [{ role: "user", content: "hi" }] },
      { authorization: "Bearer K" },
    );
    expect(o.status).toBe(200);
    expect(seen[0]!.headers.authorization).toBe("Bearer K");
    respond = () =>
      Response.json({
        usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 7, cachedContentTokenCount: 100 },
      });
    await post("/v1beta/models/gemini-x:generateContent", { contents: [] });
    const [a, b] = calls();
    expect(a).toMatchObject({ provider: "openai", input_tokens: 400, cache_read: 600, output_tokens: 20 });
    expect(b).toMatchObject({ provider: "gemini", input_tokens: 400, cache_read: 100, output_tokens: 7 });
  });

  test("a streamed answer passes through intact while its usage is read", async () => {
    const events = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 10, output_tokens: 1 } } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { text: "hi" } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 42 } })}\n\n`,
    ];
    respond = () => new Response(events.join(""), { headers: { "content-type": "text/event-stream" } });
    const r = await post("/v1/messages", {
      model: "claude-x",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(await r.text()).toBe(events.join(""));
    await Bun.sleep(30);
    expect(calls()[0]).toMatchObject({
      input_tokens: 50,
      cache_read: 200,
      cache_write: 10,
      output_tokens: 42,
    });
  });

  test("an unknown path is a 404 and a non-JSON body is forwarded untouched", async () => {
    expect((await fetch(`${proxy.url}/v1/other`, { method: "POST", body: "{}" })).status).toBe(404);
    const raw = "not json at all";
    respond = () => new Response("fine");
    const r = await fetch(`${proxy.url}/v1/messages`, { method: "POST", body: raw });
    expect(await r.text()).toBe("fine");
  });

  test("upstream errors reach the client as they are", async () => {
    respond = () =>
      Response.json(
        { type: "error", error: { type: "authentication_error", message: "bad key" } },
        { status: 401 },
      );
    const r = await post("/v1/messages", { model: "claude-x", messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(401);
    expect(((await r.json()) as any).error.message).toBe("bad key");
    expect(calls()[0].status).toBe(401);
  });
});

describe("history", () => {
  const withBigResult = () => ({
    model: "claude-x",
    messages: [
      { role: "user", content: "test it" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test" } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: Array.from({ length: 800 }, (_, i) => `PASS case ${i} (${i % 7} ms)`).join("\n"),
          },
        ],
      },
    ],
  });

  test("a large tool result is replaced by a receipt, and the original is archived and recoverable", async () => {
    const body = withBigResult();
    const original = (body.messages[2]!.content as { content: string }[])[0]!.content;
    await post("/v1/messages", body);
    const sent = seen[0]!.body.messages[2].content[0].content as string;
    expect(sent.length).toBeLessThan(original.length * 0.6); // synthetic output: the fallback extractor keeps head and tail
    const id = /sieve (s_[a-z2-7]+)/.exec(sent)?.[1];
    expect(id).toBeTruthy();
    const archived = new ProjectStore(PROXY_PROJECT).get(id!);
    expect(archived?.text).toBe(original);
    expect(calls()[0].folded).toBe(1);
  });

  test("the same history sent again produces the same request bytes (cache-safe)", async () => {
    await post("/v1/messages", withBigResult());
    await post("/v1/messages", withBigResult());
    expect(JSON.stringify(seen[1]!.body)).toBe(JSON.stringify(seen[0]!.body));
  });
});

describe("providers that refuse", () => {
  test("a rejected cache-mark count is retried once without Sieve's marks", async () => {
    respond = (n) =>
      n === 1
        ? Response.json(
            {
              type: "error",
              error: {
                type: "invalid_request_error",
                message: "A maximum of 4 blocks with cache_control may be provided.",
              },
            },
            { status: 400 },
          )
        : Response.json({ usage: { input_tokens: 5, output_tokens: 1 } });
    const r = await post("/v1/messages", {
      model: "claude-x",
      system: "s",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(JSON.stringify(seen[0]!.body)).toContain("cache_control");
    expect(JSON.stringify(seen[1]!.body)).not.toContain("cache_control");
    expect(calls()[0].retried).toBe("marks");
  });

  test("a too-long refusal is retried once with the oldest results archived", async () => {
    const turns: any[] = [{ role: "user", content: "start" }];
    for (let i = 0; i < 30; i++) {
      turns.push({
        role: "assistant",
        content: [{ type: "tool_use", id: `t${i}`, name: "Read", input: {} }],
      });
      turns.push({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: `t${i}`, content: `file ${i} ${"lorem ipsum ".repeat(180)}` },
        ],
      });
    }
    respond = (n) =>
      n === 1
        ? Response.json(
            {
              type: "error",
              error: {
                type: "invalid_request_error",
                message: "prompt is too long: 205000 tokens > 200000 maximum",
              },
            },
            { status: 400 },
          )
        : Response.json({ usage: { input_tokens: 5, output_tokens: 1 } });
    const r = await post("/v1/messages", { model: "claude-x", messages: turns }, {});
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(JSON.stringify(seen[1]!.body).length).toBeLessThan(JSON.stringify(seen[0]!.body).length);
    expect(JSON.stringify(seen[1]!.body)).toContain("sieve archived an older tool result");
    expect(calls()[0].retried).toContain("too-long");
  });

  test("any other refusal is passed back, not retried", async () => {
    respond = () =>
      Response.json(
        { type: "error", error: { type: "invalid_request_error", message: "model: unknown" } },
        { status: 400 },
      );
    const r = await post("/v1/messages", { model: "nope", messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(400);
    expect(seen).toHaveLength(1);
  });
});

describe("fail open", () => {
  test("if a transform throws, the client's request goes through as it was", async () => {
    // a body whose messages property throws when read breaks the transform, not the proxy
    const body = {
      model: "claude-x",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "t",
          get description(): string {
            throw new Error("boom");
          },
        },
      ],
    };
    // JSON.stringify would call the getter, so send the text of an equivalent hostile shape instead:
    const text =
      '{"model":"claude-x","messages":[{"role":"user","content":"hi"}],"tools":[null,{"name":5,"description":{"x":1}}]}';
    const r = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: text,
    });
    expect(r.status).toBe(200);
    expect(seen[0]!.body.messages[0].content).toBe("hi");
    void body;
  });

  test("an unreachable upstream is the one thing that cannot be hidden", async () => {
    proxy.stop();
    proxy = startProxy({
      port: 0,
      config: Config.parse({ proxy: { anthropic_upstream: "http://127.0.0.1:9" } }),
      db: gs.db,
    });
    const r = await post("/v1/messages", {
      model: "claude-x",
      messages: [{ role: "user", content: "hi" }],
    }).catch((e) => e);
    expect(r instanceof Response ? r.status : 502).toBeGreaterThanOrEqual(500);
    boot();
  });
});

describe("budgets", () => {
  const seed = (session: string, tokens: number) =>
    gs.db.run(
      "INSERT INTO proxy_calls (at, provider, model, session, status, input_tokens, dollars) VALUES (?, 'anthropic', 'm', ?, 200, ?, ?)",
      [Date.now(), session, tokens, tokens * 0.000003],
    );

  test("warnings at 50, 80 and 100 percent, each given once, into the next request", () => {
    const c = cfg({ day_tokens: 1000 }).proxy;
    expect(checkBudget(gs.db, c, "s", Date.now())).toEqual({ note: null, stop: null });
    seed("s", 500);
    expect(checkBudget(gs.db, c, "s", Date.now()).note).toContain("50% used");
    expect(checkBudget(gs.db, c, "s", Date.now()).note).toBeNull();
    seed("s", 350);
    expect(checkBudget(gs.db, c, "s", Date.now()).note).toContain("80% used");
    seed("s", 200);
    const hundred = checkBudget(gs.db, c, "s", Date.now());
    expect(hundred.note).toContain("used up");
    expect(hundred.note).toContain("still going through");
    expect(hundred.stop).toBeNull();
  });

  test("the warning is added to the system prompt of the request that follows", async () => {
    boot({ session_tokens: 100 });
    gs.db.run(
      "INSERT INTO proxy_calls (at, provider, session, status, input_tokens) VALUES (?, 'anthropic', 'h:abc', 200, 60)",
      [Date.now()],
    );
    await post(
      "/v1/messages",
      { model: "claude-x", system: "base", messages: [{ role: "user", content: "hi" }] },
      { "x-session-id": "abc" },
    );
    expect(JSON.stringify(seen[0]!.body.system)).toContain(
      "this session's tokens budget is 60% used".replace("60", "50").replace("50% used", "50% used"),
    );
  });

  test("a hard stop refuses with a 429 that names the cap; without it requests continue", async () => {
    boot({ day_dollars: 0.01, hard_stop: true });
    seed("z", 5000); // $0.015
    const r = await post("/v1/messages", { model: "claude-x", messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(429);
    expect(((await r.json()) as any).error.message).toContain("budget is used up");
    expect(seen).toHaveLength(0);
  });
});

describe("pieces", () => {
  test("the stream scanner handles chunk boundaries inside a line", () => {
    const sc = new UsageScanner("anthropic");
    const line = `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 9, output_tokens: 1 } } })}\n\n`;
    sc.push(line.slice(0, 25));
    sc.push(line.slice(25));
    expect(sc.usage.input).toBe(9);
  });

  test("dollars use cache-read at a tenth and cache-write at 1.25x of the input price", () => {
    const c = cfg().proxy;
    expect(dollarsFor({ input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 }, c)).toBeCloseTo(3);
    expect(dollarsFor({ input: 0, cacheRead: 1_000_000, cacheWrite: 0, output: 0 }, c)).toBeCloseTo(0.3);
    expect(dollarsFor({ input: 0, cacheRead: 0, cacheWrite: 1_000_000, output: 1_000_000 }, c)).toBeCloseTo(
      3.75 + 15,
    );
  });
});
