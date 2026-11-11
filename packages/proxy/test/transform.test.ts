import { describe, expect, test } from "bun:test";
import {
  type Archiver,
  addCacheMarks,
  contextWindow,
  type ProxyLimits,
  parseTooLong,
  transformAnthropic,
  transformGemini,
  transformOpenAI,
  trimDescription,
} from "../src/index.ts";

const lim: ProxyLimits = {
  trimDescriptionBytes: 1500,
  foldResultBytes: 2000,
  archiveAt: 0.6,
  archiveStep: 2,
  keepRecentMessages: 4,
  addCacheMarks: true,
  foldHistory: true,
  trimTools: true,
};

/** An archiver that records what it saw and answers with a stable fake id. */
function fakeArchiver() {
  const seen: string[] = [];
  const id = (t: string) =>
    `s_${[...t]
      .reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1e9, 7)
      .toString(36)
      .replace(/[0189]/g, "a")}`;
  const a: Archiver = {
    archive: (t) => {
      seen.push(t);
      return id(t);
    },
    receipt: (t) => {
      seen.push(t);
      return { id: id(t), text: `[sieve ${id(t)}] ${t.length} chars kept 3 lines` };
    },
  };
  return { a, seen };
}

const long = (n: number, w = "word") => Array.from({ length: n }, () => w).join(" ");

describe("tool descriptions", () => {
  test("short ones are untouched; long ones are cut at a sentence and point at sieve_schema", () => {
    expect(trimDescription("Short and sweet.", 1500, "t")).toBe("Short and sweet.");
    const d = `${"This tool does a thing. ".repeat(120)}`;
    const t = trimDescription(d, 1500, "my_tool");
    expect(Buffer.byteLength(t)).toBeLessThanOrEqual(1500);
    expect(t).toContain('(full text: sieve_schema {"tool":"my_tool"})');
    expect(t.split(" […]")[0]!.endsWith(".")).toBe(true);
  });

  test("multi-byte text is cut within the byte budget", () => {
    const t = trimDescription("é".repeat(3000), 1500, "x");
    expect(Buffer.byteLength(t)).toBeLessThanOrEqual(1500);
  });

  test("Anthropic: parameters and required stay; the full definition is kept for sieve_schema", () => {
    const tool = {
      name: "big",
      description: "Does it. ".repeat(400),
      input_schema: {
        type: "object",
        properties: { a: { type: "string", description: "x".repeat(900) } },
        required: ["a"],
      },
    };
    const r = transformAnthropic({ model: "claude-x", messages: [], tools: [tool] }, lim, fakeArchiver().a);
    const t = r.body.tools[0];
    expect(t.input_schema).toEqual(tool.input_schema);
    expect(t.description.length).toBeLessThan(1600);
    expect(r.stats.trimmedBytes).toBeGreaterThan(2000);
    expect(r.stats.schemas[0]).toEqual({ name: "big", definition: tool });
  });

  test("OpenAI and Gemini shapes", () => {
    const o = transformOpenAI(
      {
        model: "gpt",
        messages: [],
        tools: [
          {
            type: "function",
            function: { name: "f", description: "Long. ".repeat(500), parameters: { type: "object" } },
          },
        ],
      },
      lim,
      fakeArchiver().a,
    );
    expect(o.body.tools[0].function.description).toContain("sieve_schema");
    expect(o.body.tools[0].function.parameters).toEqual({ type: "object" });
    const g = transformGemini(
      { tools: [{ functionDeclarations: [{ name: "g", description: "Long. ".repeat(500) }] }] },
      lim,
    );
    expect(g.body.tools[0].functionDeclarations[0].description).toContain("sieve_schema");
  });

  test("the input is never mutated", () => {
    const input = {
      model: "claude-x",
      messages: [],
      tools: [{ name: "big", description: "Does it. ".repeat(400), input_schema: {} }],
    };
    const before = JSON.stringify(input);
    transformAnthropic(input, lim, fakeArchiver().a);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("tool results in history", () => {
  const conv = (result: string, extra: Record<string, unknown> = {}) => ({
    model: "claude-x",
    messages: [
      { role: "user", content: "run the tests" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: result, ...extra }] },
    ],
  });

  test("a large result becomes a receipt on first sight; the same history gives the same bytes", () => {
    const { a, seen } = fakeArchiver();
    const big = long(2000);
    const r1 = transformAnthropic(conv(big), lim, a);
    expect(r1.body.messages[2].content[0].content).toMatch(/^\[sieve s_/);
    expect(r1.stats.folded).toBe(1);
    expect(seen).toContain(big);
    const r2 = transformAnthropic(conv(big), lim, fakeArchiver().a);
    expect(JSON.stringify(r2.body)).toBe(JSON.stringify(r1.body)); // cache-safe: a pure function of the input
  });

  test("small results, failed results and the results of edit tools are left alone", () => {
    const { a } = fakeArchiver();
    expect(transformAnthropic(conv("ok"), lim, a).stats.folded).toBe(0);
    expect(transformAnthropic(conv(long(2000), { is_error: true }), lim, a).stats.folded).toBe(0);
    const edit = conv(long(2000));
    (edit.messages[1]!.content as { name?: string }[])[1]!.name = "Edit";
    expect(transformAnthropic(edit, lim, a).stats.folded).toBe(0);
  });

  test("results with images, thinking blocks, user text and tool inputs are untouched", () => {
    const { a } = fakeArchiver();
    const body = {
      model: "claude-x",
      messages: [
        { role: "user", content: "x ".repeat(5000) },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hm", signature: "SIG" },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls", big: long(2000) } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                { type: "image", source: {} },
                { type: "text", text: long(2000) },
              ],
            },
          ],
        },
      ],
    };
    const r = transformAnthropic(body, { ...lim, addCacheMarks: false }, a); // marks are tested below
    expect(r.body.messages[0]).toEqual(body.messages[0]);
    expect(r.body.messages[1]).toEqual(body.messages[1]);
    expect(r.body.messages[2]).toEqual(body.messages[2]); // mixed content stays
  });

  test("OpenAI tool messages are folded too, skipping edit tools", () => {
    const { a } = fakeArchiver();
    const body = {
      model: "gpt",
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "c1", function: { name: "run", arguments: '{"command":"ls"}' } },
            { id: "c2", function: { name: "apply_patch", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: long(2000) },
        { role: "tool", tool_call_id: "c2", content: long(2000) },
      ],
    };
    const r = transformOpenAI(body, lim, a);
    expect(r.body.messages[1].content).toMatch(/^\[sieve s_/);
    expect(r.body.messages[2].content).toBe(body.messages[2]!.content);
  });
});

describe("archiving old results in fixed steps", () => {
  function longConversation(turns: number, size: number) {
    const messages: unknown[] = [{ role: "user", content: "start" }];
    for (let i = 0; i < turns; i++) {
      messages.push({
        role: "assistant",
        content: [{ type: "tool_use", id: `t${i}`, name: "Read", input: { path: `f${i}` } }],
      });
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `result ${i} ${long(size)}` }],
      });
    }
    return { model: "claude-x", messages };
  }
  // a small window makes the threshold easy to reach
  const small: ProxyLimits = { ...lim, foldResultBytes: 1e9, archiveAt: 0.5 };

  test("under the threshold nothing is archived", () => {
    const r = transformAnthropic({ ...longConversation(4, 100), model: "claude-x" }, small, fakeArchiver().a);
    expect(r.stats.archived).toBe(0);
  });

  test("past it, the oldest results go in multiples of the step, the newest are kept", () => {
    const body = longConversation(60, 2200); // ~ 60 x 3k tokens = 180k+ of a 200k window
    const r = transformAnthropic(body, small, fakeArchiver().a);
    expect(r.stats.archived).toBeGreaterThan(0);
    expect(r.stats.archived % small.archiveStep).toBe(0);
    const first = r.body.messages[2].content[0].content as string;
    expect(first).toMatch(/^\[sieve archived an older tool result/);
    expect(first).toContain('sieve_get {"id":"s_');
    const n = r.body.messages.length;
    for (let i = n - small.keepRecentMessages; i < n; i++) {
      const m = r.body.messages[i];
      if (Array.isArray(m.content) && m.content[0].type === "tool_result")
        expect(m.content[0].content).not.toMatch(/^\[sieve archived/);
    }
  });

  test("one more turn changes the archived set only at a step boundary", () => {
    const a = transformAnthropic(longConversation(60, 2200), small, fakeArchiver().a);
    const b = transformAnthropic(longConversation(61, 2200), small, fakeArchiver().a);
    expect(b.stats.archived - a.stats.archived).toBeLessThanOrEqual(small.archiveStep);
    expect(b.stats.archived % small.archiveStep).toBe(0);
  });

  test("a forced cut (after a too-long refusal) archives enough to clear the overshoot", () => {
    const body = longConversation(40, 2200);
    const r = transformAnthropic(body, { ...small, archiveAt: 0.95 }, fakeArchiver().a, { force: 30_000 });
    expect(r.stats.archived).toBeGreaterThan(0);
    const saved = JSON.stringify(body).length - JSON.stringify(r.body).length;
    expect(saved / 3.6).toBeGreaterThan(30_000);
  });
});

describe("cache marks", () => {
  const mark = { type: "ephemeral" };
  test("added where free: system end, tool list end, the conversation so far", () => {
    const body = {
      system: "be brief",
      tools: [{ name: "a" }, { name: "b" }],
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
        { role: "user", content: "again" },
      ],
    };
    expect(addCacheMarks(body)).toBe(3);
    expect(body.system as unknown).toEqual([{ type: "text", text: "be brief", cache_control: mark }]);
    expect((body.tools[1] as { cache_control?: unknown }).cache_control).toEqual(mark);
    expect((body.tools[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
    expect((body.messages[1]!.content as { cache_control?: unknown }[])[0]!.cache_control).toEqual(mark);
  });

  test("the client's marks are never removed and the total never passes four", () => {
    const body = {
      system: [{ type: "text", text: "s", cache_control: mark }],
      tools: [{ name: "a", cache_control: mark }],
      messages: [
        { role: "user", content: [{ type: "text", text: "1", cache_control: mark }] },
        { role: "assistant", content: [{ type: "text", text: "2", cache_control: mark }] },
        { role: "user", content: "3" },
      ],
    };
    const before = JSON.stringify(body);
    expect(addCacheMarks(body)).toBe(0); // four already
    expect(JSON.stringify(body)).toBe(before);
  });

  test("with some free slots, only that many are added", () => {
    const body = {
      system: [{ type: "text", text: "s", cache_control: mark }],
      tools: [{ name: "a" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "x", cache_control: mark }] },
        { role: "assistant", content: [{ type: "text", text: "y", cache_control: mark }] },
        { role: "user", content: "z" },
      ],
    };
    expect(addCacheMarks(body)).toBe(1);
    expect(JSON.stringify(body).match(/cache_control/g)).toHaveLength(4);
  });

  test("never marks a thinking block", () => {
    const body = {
      tools: [],
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }] },
        { role: "user", content: "b" },
      ],
    };
    expect(addCacheMarks(body)).toBe(0);
  });
});

describe("helpers", () => {
  test("context windows from model names", () => {
    expect(contextWindow("claude-sonnet-4")).toBe(200_000);
    expect(contextWindow("claude-opus-4[1m]")).toBe(1_000_000);
    expect(contextWindow("gpt-4.1-mini")).toBe(1_000_000);
    expect(contextWindow("llama3.1:8b")).toBe(128_000);
    expect(contextWindow(undefined)).toBe(128_000);
  });

  test("refusals for a too-long prompt, from both providers' wording", () => {
    expect(parseTooLong("prompt is too long: 215000 tokens > 200000 maximum")).toEqual({
      actual: 215000,
      limit: 200000,
    });
    expect(
      parseTooLong(
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 131,500 tokens.",
      ),
    ).toEqual({ actual: 131500, limit: 128000 });
    expect(parseTooLong("invalid x-api-key")).toBeNull();
    expect(parseTooLong("too long")).toBeNull();
  });
});
