import { formatInt } from "../text.ts";

let lastText: string | null = null;
let lastLines: readonly string[] = [];

/**
 * Split into lines (no trailing empty line). Every extractor's detect() asks for the lines of
 * the same text, so the last result is cached; it is frozen so no caller can change it for
 * the next one.
 */
export const lines = (text: string): string[] => {
  if (text !== lastText) {
    const l = text.split("\n");
    if (l.length > 1 && l[l.length - 1] === "") l.pop();
    lastText = text;
    lastLines = Object.freeze(l);
  }
  return lastLines as string[];
};

export const plural = (n: number, one: string, many = `${one}s`) => `${formatInt(n)} ${n === 1 ? one : many}`;

/** Fraction of the first `sample` non-empty lines that match. */
export function share(ls: string[], re: RegExp, sample = 300): number {
  let n = 0;
  let hit = 0;
  for (const l of ls) {
    if (!l.trim()) continue;
    if (++n > sample) break;
    if (re.test(l)) hit++;
  }
  return n ? hit / Math.min(n, sample) : 0;
}

export const cmdMatches = (cmd: string | undefined, re: RegExp) => !!cmd && re.test(cmd);

/** Paths that belong to dependencies, the standard library or the runtime, not to the project. */
export const LIB_PATH =
  /node_modules\/|site-packages\/|dist-packages\/|\/lib\/python\d|\/libexec\/src\/|\/usr\/(local\/)?go\/src\/|\/go\/pkg\/mod\/|\/rustc\/[0-9a-f]|\.cargo\/registry|\/gems\/|node:internal|\(internal\/|<anonymous>|\/\.bun\/install\//;

const FRAME = /^\s+(at |❯ |# |File ")|^\t\S/;

/**
 * Collapse runs of two or more library stack frames into one counted line. Handles JS
 * (`at …`, `❯ …`), Ruby (`# …`), Python (`File "…"` + the code line under it) and Go
 * (function line + tab-indented path line). Project frames are never touched.
 */
export function collapseLibraryFrames(input: string[]): { out: string[]; frames: number } {
  const out: string[] = [];
  let frames = 0;
  let i = 0;
  while (i < input.length) {
    let j = i;
    let run = 0;
    for (;;) {
      const size = libFrameAt(input, j);
      if (!size) break;
      j += size;
      run++;
    }
    if (run >= 2) {
      const indent = /^\s*/.exec(input[i]!)![0];
      out.push(`${indent}… ${plural(run, "library frame")}`);
      frames += run;
      i = j;
    } else {
      out.push(input[i]!);
      i++;
    }
  }
  return { out, frames };
}

/** Number of lines the library frame at `i` spans, or 0. */
function libFrameAt(ls: string[], i: number): number {
  const l = ls[i];
  if (l === undefined) return 0;
  // Go: "pkg.Func(…)" then "\t/path/file.go:12 +0x1c"
  const next = ls[i + 1];
  if (/^\S.*\)$/.test(l) && next !== undefined && /^\t\//.test(next) && LIB_PATH.test(next)) return 2;
  if (/^created by /.test(l) && next !== undefined && /^\t\//.test(next) && LIB_PATH.test(next)) return 2;
  if (!FRAME.test(l) || !LIB_PATH.test(l)) return 0;
  // Python: the source line printed under a File "…" frame belongs to it.
  if (/^\s+File "/.test(l) && next !== undefined && /^\s{4,}\S/.test(next) && !FRAME.test(next)) return 2;
  return 1;
}

/**
 * Replace every line matching `match` with nothing, and put a single counted line where the
 * first one was. Returns the count.
 */
export function foldLines(
  input: string[],
  match: (l: string) => boolean,
  label: (n: number) => string,
): { out: string[]; n: number } {
  const out: string[] = [];
  let n = 0;
  let at = -1;
  for (const l of input) {
    if (match(l)) {
      if (at === -1) at = out.length;
      n++;
    } else out.push(l);
  }
  if (n > 0) out.splice(at, 0, label(n));
  return { out, n };
}

/** Drop blank lines that repeat, so removed blocks do not leave holes. */
export function squeezeBlank(input: string[]): string[] {
  const out: string[] = [];
  for (const l of input) {
    if (!l.trim() && out.length && !out[out.length - 1]!.trim()) continue;
    out.push(l);
  }
  while (out.length && !out[0]!.trim()) out.shift();
  while (out.length && !out[out.length - 1]!.trim()) out.pop();
  return out;
}

export function compact(dropped: Array<string | false | null | undefined>): string[] {
  return dropped.filter((d): d is string => typeof d === "string" && d.length > 0);
}
