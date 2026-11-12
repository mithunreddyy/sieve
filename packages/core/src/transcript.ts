import { cleanPrompt } from "./intent.ts";

/**
 * The user's latest prompt in a Claude Code transcript (JSON lines), or null.
 *
 * Why: a daemon that was not running when a session began misses its first hooks (seen in every
 * fresh benchmark run: SessionStart and the first UserPromptSubmit were "daemon-down"), so it never
 * learns the task. The transcript, whose path every hook payload carries, has it.
 *
 * Skipped: tool results, entries Claude Code injected itself (`isMeta`), subagent entries
 * (`isSidechain`), slash-command records, and anything that does not parse (the first line of a tail
 * read is usually torn). Pure.
 */
export function lastUserPrompt(jsonl: string): string | null {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.trim();
    if (!l.startsWith("{")) continue;
    let e: { type?: unknown; isMeta?: unknown; isSidechain?: unknown; message?: { content?: unknown } };
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (e.type !== "user" || e.isMeta === true || e.isSidechain === true) continue;
    const c = e.message?.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) {
      if (c.some((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "tool_result"))
        continue;
      text = c
        .filter((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "text")
        .map((b) => String((b as { text?: unknown }).text ?? ""))
        .join("\n");
    }
    const t = text.trim();
    if (!t || /^<(command-name|local-command|command-message|system-reminder)/.test(t)) continue;
    const clean = cleanPrompt(t).trim();
    if (clean) return clean;
  }
  return null;
}
