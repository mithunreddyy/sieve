import type { Extractor } from "./types.ts";
import { compact, plural } from "./util.ts";

const MAX_ITEMS = 20;
const KEEP_HEAD = 3;
const MAX_STRING = 600;

/** A type sketch of a JSON value, two levels deep: `array[30] of object{id, title, user{…}}`. */
export function shape(v: unknown, depth = 0): string {
  if (Array.isArray(v)) {
    if (!v.length) return "array[0]";
    const kinds = [
      ...new Set(v.slice(0, 50).map((x) => (x === null ? "null" : Array.isArray(x) ? "array" : typeof x))),
    ];
    return `array[${v.length}] of ${kinds.length === 1 && kinds[0] === "object" && depth < 2 ? shape(v[0], depth + 1) : kinds.join("|")}`;
  }
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (depth >= 2) return `object{${plural(keys.length, "key")}}`;
    const parts = keys.slice(0, 30).map((k) => {
      const x = (v as Record<string, unknown>)[k];
      return x && typeof x === "object" ? `${k}: ${shape(x, depth + 1)}` : k;
    });
    return `object{${parts.join(", ")}${keys.length > 30 ? `, … ${keys.length - 30} more` : ""}}`;
  }
  return v === null ? "null" : typeof v;
}

/**
 * Keep every key. Arrays over 20 items keep the first 3 and the last, with a count of what
 * was skipped; strings over 600 characters are cut with their length stated.
 */
export const json: Extractor = {
  id: "json",
  detect: ({ text }) => {
    const t = text.trimStart();
    if (!(t.startsWith("{") || t.startsWith("[")) || text.length > 16 * 1024 * 1024) return 0;
    try {
      JSON.parse(text);
      return 90;
    } catch {
      return 0;
    }
  },
  extract({ text }) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    let items = 0;
    let arrays = 0;
    let strings = 0;
    const reduce = (v: unknown): unknown => {
      if (Array.isArray(v)) {
        if (v.length <= MAX_ITEMS) return v.map(reduce);
        arrays++;
        items += v.length - KEEP_HEAD - 1;
        return [
          ...v.slice(0, KEEP_HEAD).map(reduce),
          `… ${v.length - KEEP_HEAD - 1} more items (indexes ${KEEP_HEAD}-${v.length - 2}) …`,
          reduce(v[v.length - 1]),
        ];
      }
      if (v && typeof v === "object")
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, reduce(x)]));
      if (typeof v === "string" && v.length > MAX_STRING) {
        strings++;
        return `${v.slice(0, MAX_STRING)}… (+${v.length - MAX_STRING} chars)`;
      }
      return v;
    };
    const reduced = reduce(value);
    return {
      extractor: "json",
      body: `shape: ${shape(value)}\n${JSON.stringify(reduced, null, 1)}`,
      dropped: compact([
        items > 0 && `${plural(items, "array item")} from ${plural(arrays, "long array")}`,
        strings > 0 && `the tails of ${plural(strings, "long string")}`,
        "indentation",
      ]),
      keptVerbatim: false,
    };
  },
};
