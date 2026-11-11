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
