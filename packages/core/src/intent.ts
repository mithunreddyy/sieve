import { queryTerms } from "./search.ts";

const STOP = new Set(
  (
    "the and for are but not you your yours with this that these those have has had was were been being from into onto over " +
    "under out off than then them they their there here what when where which who whom why how can could should would will " +
    "shall may might must does did doing done its it's let lets just also only any all some each every other another such " +
    "now please make made use used using get got see look find show tell give want need like about after before again " +
    "file files code line lines read write run running fix bug bugs thing things stuff more most less very much many"
  ).split(" "),
);

/** Remove tag blocks that agent harnesses wrap around prompts (IDE context, system reminders). */
export function cleanPrompt(prompt: string): string {
  return prompt
    .replace(
      /<(ide_[a-z_]+|system-reminder|local-command-[a-z]+|command-[a-z]+|pasted_content[^>]*)[^>]*>[\s\S]*?<\/\1>/gi,
      " ",
    )
    .replace(/<[a-z_-]+>[\s\S]*?<\/[a-z_-]+>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The words in a request worth matching against file or output lines: no stopwords, no
 * very short words, at most 8 (the rarest are chosen later by the matcher).
 */
export function intentTerms(intent: string | undefined, keepNumbers = false): string[] {
  if (!intent) return [];
  return queryTerms(cleanPrompt(intent))
    .filter((t) => (t.length >= 3 || (keepNumbers && /^\d+$/.test(t))) && !STOP.has(t))
    .slice(0, 8);
}
