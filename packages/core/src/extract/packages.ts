import type { Extractor } from "./types.ts";
import { cmdMatches, compact, lines, plural, squeezeBlank } from "./util.ts";

/**
 * Package managers: keep errors, warnings (deprecations included) and version changes;
 * progress and per-package fetch chatter become counted lines.
 */
const PROGRESS: Array<[RegExp, string]> = [
  [/^\s*Collecting /, "Collecting"],
  [
    /^\s*(Downloading|Using cached|Obtaining|Preparing metadata|Getting requirements|Installing build dependencies|Building wheels? for|Created wheel for|Stored in directory|Requirement already satisfied)\b/,
    "fetch/build",
  ],
  [/^Progress: resolved /, "Progress"],
  [/^\++-*$|^[+-]{20,}$|^\s*[━─█▉▊▋▌▍▎▏░▒▓#=>]{10,}/, "progress bar"],
  [
    /^\s*(Resolving|Fetching|Linking|Resolved|Downloaded|Installing|Saved lockfile|Already up[- ]to[- ]date|Lockfile is up to date)\b.*$/i,
    "resolve/fetch",
  ],
  [/^\s*[⠀-⣿⠁-⣿⡀-⢿|/\\-]\s/, "spinner"],
  [/^npm (http|timing|silly|verbose) /, "npm debug"],
  [/^\s+Compiling \S+ v\d|^\s+Downloaded \S+ v\d/, "Compiling/Downloaded"],
];
const KEEP =
  /\b(warn(ing)?|WARN(ING)?|err(or)?|ERR!?|ERROR|deprecated|DEPRECATED|fail(ed)?|FAIL(ED)?|vulnerab|notice)\b/;

export const pkg: Extractor = {
  id: "pkg",
  detect: ({ command, text }) =>
    cmdMatches(
      command,
      /\b(npm|pnpm|yarn|bun|pip3?|uv|poetry|cargo|gem|bundle|composer)\s+(install|i|add|ci|update|upgrade|sync|remove|fetch)\b/,
    ) || cmdMatches(command, /\buv pip install\b/)
      ? 90
      : /^(added \d+ packages?|Successfully installed |Packages: \+\d+|Done in [\d.]+m?s)/m.test(text)
        ? 70
        : 0,
  extract({ text }) {
    const counts = new Map<string, number>();
    const lastProgress = new Map<string, string>();
    const out: string[] = [];
    for (const l of lines(text)) {
      const p =
        KEEP.test(l) && !/^npm (http|timing|silly|verbose) /.test(l)
          ? undefined
          : PROGRESS.find(([re]) => re.test(l));
      if (p) {
        const [, kind] = p;
        if (!counts.has(kind)) out.push(`\u0000${kind}`);
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
        if (kind === "Progress") lastProgress.set(kind, l);
        continue;
      }
      out.push(l);
    }
    const body = out.map((l) => {
      if (!l.startsWith("\u0000")) return l;
      const kind = l.slice(1);
      const n = counts.get(kind)!;
      return kind === "Progress"
        ? `${lastProgress.get(kind)}  (last of ${plural(n, "progress line")})`
        : `(${plural(n, `${kind} line`)})`;
    });
    if (!counts.size) return null;
    return {
      extractor: "pkg",
      body: squeezeBlank(body).join("\n"),
      dropped: compact([...counts].map(([k, n]) => plural(n, `${k} line`))),
      keptVerbatim: /\b(ERR!|ERROR|error)\b/.test(text),
    };
  },
};
