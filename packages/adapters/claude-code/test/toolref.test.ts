import { describe, expect, test } from "bun:test";
import { toolRef } from "../src/index.ts";

describe("toolRef", () => {
  test("Sieve's own MCP tools are recognised however they were registered", () => {
    expect(toolRef("mcp__sieve__sieve_get")).toEqual({
      name: "mcp__sieve__sieve_get",
      family: "mcp",
      server: "sieve",
    });
    // Through the plugin: mcp__plugin_<plugin>_<server>__<tool> (seen in real transcripts: mcp__plugin_figma_figma__…)
    expect(toolRef("mcp__plugin_sieve_sieve__sieve_index").server).toBe("sieve");
  });
  test("other plugins' servers keep their own name, and a look-alike is not Sieve", () => {
    expect(toolRef("mcp__plugin_figma_figma__authenticate").server).toBe("plugin_figma_figma");
    expect(toolRef("mcp__plugin_sieve_other__x").server).toBe("plugin_sieve_other");
    expect(toolRef("mcp__plugin_notsieve_sieve__x").server).toBe("plugin_notsieve_sieve");
  });
});

describe("persistedOf", () => {
  test("a subagent's result: its payload carries the main session's transcript, so its tool-results folder is that session's", async () => {
    const { persistedOf } = await import("../src/index.ts");
    // shape observed live (Claude Code 2.1.319): agent_id/agent_type present, transcript_path = the main session's
    const p = persistedOf(
      {
        stdout: "x",
        persistedOutputPath: "/c/projects/-p/SESSION/tool-results/b1.txt",
        persistedOutputSize: 61893,
      },
      "/c/projects/-p/SESSION.jsonl",
    );
    expect(p).toEqual({
      totalBytes: 61893,
      file: "/c/projects/-p/SESSION/tool-results/b1.txt",
      dir: "/c/projects/-p/SESSION/tool-results",
    });
  });
  test("no transcript path, or no size: nothing to read from, and nothing invented", async () => {
    const { persistedOf } = await import("../src/index.ts");
    expect(
      persistedOf({ stdout: "x", persistedOutputPath: "/a/b.txt", persistedOutputSize: 5 }, undefined),
    ).toEqual({ totalBytes: 5, file: "/a/b.txt" });
    expect(persistedOf({ stdout: "x" }, "/c/s.jsonl")).toBeUndefined();
    expect(persistedOf("a string", "/c/s.jsonl")).toBeUndefined();
    expect(persistedOf({ persistedOutputSize: "5" }, "/c/s.jsonl")).toBeUndefined();
  });
});

describe("WebFetch results (shape seen in real transcripts: {bytes, code, codeText, durationMs, result, url})", () => {
  const wf = {
    bytes: 5573,
    code: 200,
    codeText: "OK",
    durationMs: 8145,
    result: "the page text",
    url: "https://example.com/",
  };
  test("the text is `result`, not a JSON dump of the object", async () => {
    const { outputText } = await import("../src/index.ts");
    expect(outputText(wf)).toEqual({ text: "the page text", isError: false });
  });
  test("a replacement keeps every other field and swaps `result`", async () => {
    const { replacementFor, canReplaceOutput } = await import("../src/index.ts");
    expect(replacementFor(wf, "RECEIPT")).toEqual({ ...wf, result: "RECEIPT" });
    expect(canReplaceOutput(wf)).toBe(true);
  });
  test("a shape Sieve cannot put a receipt into is reported as such", async () => {
    const { canReplaceOutput } = await import("../src/index.ts");
    expect(canReplaceOutput({ weird: 1 })).toBe(false);
    expect(canReplaceOutput({ stdout: "x", stderr: "" })).toBe(true);
  });
});
