import { describe, expect, test } from "bun:test";
import { lastUserPrompt } from "../src/index.ts";

/**
 * A cold daemon misses the session's first hooks (found: in every fresh benchmark run, SessionStart and
 * the first UserPromptSubmit were "daemon-down"), so it never learned the task. Claude Code's transcript
 * has it; these are the entry shapes seen in a real transcript.
 */
const line = (o: unknown) => JSON.stringify(o);
const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: "user", message: { role: "user", content }, ...extra });

describe("lastUserPrompt", () => {
  test("the latest real prompt, skipping tool results, injected (isMeta) entries and subagent (sidechain) ones", () => {
    const t = [
      user("first task: refactor the parser"),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
      user([{ type: "text", text: "Reply with only the email address of the user whose id is 137." }]),
      user([{ type: "tool_result", tool_use_id: "t1", content: "lots of output" }]),
      user("<system-reminder>injected</system-reminder>", { isMeta: true }),
      user("subagent instructions", { isSidechain: true }),
      user([{ type: "tool_result", tool_use_id: "t2", content: "more" }]),
    ].join("\n");
    expect(lastUserPrompt(t)).toBe("Reply with only the email address of the user whose id is 137.");
  });
  test("a slash-command record is not a prompt", () => {
    const t = [
      user("find the failing test"),
      user("<command-name>/model</command-name>\n<command-args>opus</command-args>"),
    ].join("\n");
    expect(lastUserPrompt(t)).toBe("find the failing test");
  });
  test("a torn first line (the tail of a big file) and garbage are skipped", () => {
    const t = ['e": "half a line"}', user("what port does payments use?"), "not json"].join("\n");
    expect(lastUserPrompt(t)).toBe("what port does payments use?");
  });
  test("no prompt at all: null", () => {
    expect(
      lastUserPrompt([user([{ type: "tool_result", tool_use_id: "x", content: "y" }])].join("\n")),
    ).toBeNull();
    expect(lastUserPrompt("")).toBeNull();
  });
});
