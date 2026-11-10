import { structuredPatch } from "diff";

export interface Hunks {
  body: string;
  hunks: number;
  add: number;
  del: number;
}

/**
 * A unified diff of two texts, or null when they differ in more than `maxChangedShare` of
 * their lines. Myers diff costs O(N·D), so a large change is detected first with an O(N)
 * line-multiset count and never diffed; jsdiff's maxEditLength is a second guard.
 */
export function boundedDiff(a: string, b: string, maxChangedShare: number, context: number): Hunks | null {
  const al = a.split("\n");
  const bl = b.split("\n");
  const counts = new Map<string, number>();
  for (const l of al) counts.set(l, (counts.get(l) ?? 0) + 1);
  let changed = 0;
  for (const l of bl) {
    const n = counts.get(l) ?? 0;
    if (n > 0) counts.set(l, n - 1);
    else changed++;
  }
  const limit = Math.max(1, Math.floor(Math.max(al.length, bl.length) * maxChangedShare));
  if (changed > limit) return null;
  const patch = structuredPatch("a", "b", a, b, "", "", { context, maxEditLength: limit * 2 + 10 });
  if (!patch) return null;
  const body = patch.hunks
    .map((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines].join("\n"))
    .join("\n");
  return {
    body,
    hunks: patch.hunks.length,
    add: patch.hunks.reduce((n, h) => n + h.lines.filter((l) => l.startsWith("+")).length, 0),
    del: patch.hunks.reduce((n, h) => n + h.lines.filter((l) => l.startsWith("-")).length, 0),
  };
}
