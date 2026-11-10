import type { Extraction, Extractor } from "./types.ts";
import { cmdMatches, compact, lines, plural, share, squeezeBlank } from "./util.ts";

/**
 * Compilers and linters. Diagnostics are grouped by (severity, code, message template);
 * a group keeps one full example block and lists EVERY location, plus the identifiers
 * that differ between locations. Errors come before warnings. Nothing a fix needs is lost:
 * only repeated message text and repeated code frames are dropped.
 */
export interface Diag {
  severity: "error" | "warning" | "note" | "info";
  code: string;
  message: string;
  location: string;
  /** The full original block (header + frame + notes). */
  block: string[];
}

const QUOTED = /'[^']*'|"[^"]*"|`[^`]*`|‘[^’]*’/g;
export function template(msg: string): { key: string; vars: string[] } {
  const vars: string[] = [];
  const key = msg.replace(QUOTED, (m) => {
    vars.push(m);
    return "‹…›";
  });
  return { key, vars };
}

const RANK = { error: 0, warning: 1, note: 2, info: 3 } as const;
const MAX_LOCATIONS = 200;

export function renderDiagnostics(
  id: string,
  diags: Diag[],
  other: string[],
  parsedLines: number,
): Extraction {
  const groups = new Map<string, { first: Diag; items: Diag[]; vars: string[][]; order: number }>();
  diags.forEach((d, i) => {
    const t = template(d.message);
    const key = `${d.severity}\u0000${d.code}\u0000${t.key}`;
    const g = groups.get(key);
    if (g) {
      g.items.push(d);
      g.vars.push(t.vars);
    } else groups.set(key, { first: d, items: [d], vars: [t.vars], order: i });
  });
  const sorted = [...groups.values()].sort(
    (a, b) => RANK[a.first.severity] - RANK[b.first.severity] || a.order - b.order,
  );
  const out: string[] = [];
  const counts = { error: 0, warning: 0, note: 0, info: 0 };
  for (const d of diags) counts[d.severity]++;
  out.push(
    `${diags.length} diagnostics in ${new Set(diags.map((d) => d.location.replace(/[:(].*$/, ""))).size} files: ${[
      counts.error && plural(counts.error, "error"),
      counts.warning && plural(counts.warning, "warning"),
      counts.note && plural(counts.note, "note"),
      counts.info && `${counts.info} info`,
    ]
      .filter(Boolean)
      .join(", ")} · ${plural(sorted.length, "distinct message")}`,
  );
  let folded = 0;
  for (const g of sorted) {
    out.push("");
    if (g.items.length === 1) {
      out.push(...g.first.block);
      continue;
    }
    folded += g.items.length - 1;
    const sameText = g.items.every((d) => d.message === g.first.message);
    out.push(
      `${g.items.length}× ${g.first.severity}${g.first.code ? ` ${g.first.code}` : ""}: ${sameText ? g.first.message : template(g.first.message).key}`,
    );
    out.push("  first occurrence:", ...g.first.block.map((l) => `    ${l}`));
    // Every location, with the values that vary when the message differs.
    const where = new Map<string, number>();
    const locs: string[] = [];
    g.items.forEach((d, i) => {
      const label = sameText ? d.location : `${d.location} ${g.vars[i]!.join(" ")}`;
      const n = where.get(label);
      if (n === undefined) {
        where.set(label, 1);
        locs.push(label);
      } else where.set(label, n + 1);
    });
    const shown = locs
      .slice(0, MAX_LOCATIONS)
      .map((l) => (where.get(l)! > 1 ? `${l} (×${where.get(l)})` : l));
    out.push(
      `  all ${plural(g.items.length, "location")}: ${shown.join(", ")}${locs.length > MAX_LOCATIONS ? `, … ${locs.length - MAX_LOCATIONS} more (in the archive)` : ""}`,
    );
  }
  // Summary and other lines that are not diagnostics; identical repeats are counted.
  const seen = new Map<string, number>();
  const rest: string[] = [];
  for (const l of other) {
    if (!l.trim()) continue;
    const n = seen.get(l) ?? 0;
    seen.set(l, n + 1);
    if (n === 0) rest.push(l);
  }
  if (rest.length) out.push("", ...rest.map((l) => (seen.get(l)! > 1 ? `${l} (×${seen.get(l)})` : l)));
  return {
    extractor: id,
    body: squeezeBlank(out).join("\n"),
    dropped: compact([
      folded > 0 && `${plural(folded, "repeated diagnostic")} folded into their groups (locations kept)`,
      parsedLines > 0 && false,
    ]),
    keptVerbatim: counts.error > 0,
  };
}

// ------------------------------------------------------------ line-style parsers
type LineParser = (l: string) => Omit<Diag, "block"> | null;

/** One diagnostic per line, with indented continuation lines (tsc, mypy, ruff concise). */
function parseLineStyle(text: string, parse: LineParser): { diags: Diag[]; other: string[] } {
  const diags: Diag[] = [];
  const other: string[] = [];
  for (const l of lines(text)) {
    const d = parse(l);
    if (d) {
      diags.push({ ...d, block: [l] });
      continue;
    }
    const last = diags[diags.length - 1];
    if (last && /^\s+\S/.test(l)) last.block.push(l);
    else other.push(l);
  }
  return { diags, other };
}

interface DiagSpec {
  id: string;
  detect: Extractor["detect"];
  parse(text: string): { diags: Diag[]; other: string[]; dropped?: string[] };
}

/** Build an extractor whose extract() and keys() come from the same parser. */
function diag(spec: DiagSpec): Extractor {
  return {
    id: spec.id,
    detect: spec.detect,
    extract({ text }) {
      const { diags, other, dropped } = spec.parse(text);
      if (!diags.length) return null;
      const r = renderDiagnostics(spec.id, diags, other, 0);
      r.dropped.push(...(dropped ?? []));
      return r;
    },
    // A diagnostic is "the same" across runs when its severity, code and location match.
    keys: ({ text }) =>
      spec
        .parse(text)
        .diags.filter((d) => d.severity === "error" || d.severity === "warning")
        .map((d) => `${d.severity} ${d.code} ${d.location}`),
  };
}

const TSC = /^(.+?)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$/;
export const tsc = diag({
  id: "tsc",
  detect: ({ command, text }) =>
    cmdMatches(command, /\btsc\b|vue-tsc/) ? 95 : share(lines(text), TSC) > 0.4 ? 85 : 0,
  parse(text: string) {
    const { diags, other } = parseLineStyle(text, (l) => {
      const m = TSC.exec(l);
      return m
        ? {
            severity: m[4] === "error" ? "error" : m[4] === "warning" ? "warning" : "info",
            code: m[5]!,
            message: m[6]!,
            location: `${m[1]}(${m[2]},${m[3]})`,
          }
        : null;
    });
    return { diags, other };
  },
});

const MYPY = /^(.+?\.pyi?):(\d+)(?::(\d+))?: (error|warning|note): (.*?)(?:\s+\[([\w-]+)\])?$/;
export const mypy = diag({
  id: "mypy",
  detect: ({ command, text }) =>
    cmdMatches(command, /\b(mypy|dmypy)\b/) ? 95 : share(lines(text), MYPY) > 0.5 ? 80 : 0,
  parse(text: string) {
    const { diags, other } = parseLineStyle(text, (l) => {
      const m = MYPY.exec(l);
      return m
        ? {
            severity: m[4] as Diag["severity"],
            code: m[6] ?? "",
            message: m[5]!,
            location: `${m[1]}:${m[2]}${m[3] ? `:${m[3]}` : ""}`,
          }
        : null;
    });
    return { diags, other };
  },
});

// ------------------------------------------------------------ eslint (stylish)
const ESL_FILE = /^(\/|[A-Za-z]:\\|\.{0,2}\/)?[^\s:]+\.[\w]+$/;
const ESL_ROW = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?$/;
export const eslint = diag({
  id: "eslint",
  detect: ({ command, text }) =>
    cmdMatches(command, /\beslint\b/)
      ? 95
      : /^✖ \d+ problems? \(/m.test(text) && share(lines(text), ESL_ROW) > 0.4
        ? 85
        : 0,
  parse(text: string) {
    const diags: Diag[] = [];
    const other: string[] = [];
    let file = "";
    for (const l of lines(text)) {
      if (ESL_FILE.test(l)) {
        file = l;
        continue;
      }
      const m = ESL_ROW.exec(l);
      if (m && file) {
        diags.push({
          severity: m[3] as "error" | "warning",
          code: m[5] ?? "",
          message: m[4]!.trim(),
          location: `${file}:${m[1]}:${m[2]}`,
          block: [`${file}:${m[1]}:${m[2]}  ${m[3]}  ${m[4]!.trim()}  ${m[5] ?? ""}`.trimEnd()],
        });
      } else other.push(l);
    }
    return { diags, other };
  },
});

// ------------------------------------------------------------ block-style parsers
interface BlockSpec {
  header: RegExp;
  /** Turn a header (and the block) into a diagnostic. */
  make(m: RegExpExecArray, block: string[]): Omit<Diag, "block"> | null;
  /** Lines that end any block and are kept as summary lines. */
  terminal: RegExp;
}

function parseBlocks(text: string, spec: BlockSpec): { diags: Diag[]; other: string[] } {
  const diags: Diag[] = [];
  const other: string[] = [];
  let cur: { m: RegExpExecArray; block: string[] } | null = null;
  let prefix: string[] = [];
  const flush = () => {
    if (!cur) return;
    while (cur.block.length && !cur.block[cur.block.length - 1]!.trim()) cur.block.pop();
    const d = spec.make(cur.m, cur.block);
    if (d) diags.push({ ...d, block: cur.block });
    else other.push(...cur.block);
    cur = null;
  };
  for (const l of lines(text)) {
    const m = spec.header.exec(l);
    if (m) {
      flush();
      cur = { m, block: [...prefix, l] };
      prefix = [];
      continue;
    }
    if (/^In file included from /.test(l) || /^\s+from .+:\d+[,:]$/.test(l)) {
      flush();
      prefix.push(l);
      continue;
    }
    if (spec.terminal.test(l)) {
      flush();
      other.push(l);
      continue;
    }
    if (cur) cur.block.push(l);
    else other.push(l);
  }
  flush();
  return { diags, other };
}

const RUST = /^(error|warning)(?:\[(E\d+|[\w:]+)\])?: (.*)$/;
export const rustc = diag({
  id: "rustc",
  detect: ({ command, text }) =>
    cmdMatches(command, /\b(cargo\s+(build|check|clippy|run)|rustc)\b/)
      ? 95
      : /^\s+--> \S+:\d+:\d+$/m.test(text) &&
          RUST.test(text.split("\n").find((l) => RUST.test(l)) ?? "") &&
          !/^ --> /m.test(text)
        ? 80
        : 0,
  parse(text: string) {
    let compiling = 0;
    const src = lines(text).filter((l) => {
      if (/^\s+(Compiling|Checking|Downloaded|Downloading|Fresh|Locking|Updating|Adding) /.test(l)) {
        compiling++;
        return false;
      }
      return true;
    });
    const { diags, other } = parseBlocks(src.join("\n"), {
      header: RUST,
      terminal: /^(For more information|Some errors have detailed explanations|\s+Finished )/,
      make(m, block) {
        const loc = block.map((l) => /^\s*--> (.+)$/.exec(l)?.[1]).find(Boolean);
        if (!loc) return null; // "error: could not compile …" style summaries
        return { severity: m[1] as "error" | "warning", code: m[2] ?? "", message: m[3]!, location: loc };
      },
    });
    return { diags, other, dropped: compiling ? [plural(compiling, "Compiling line")] : [] };
  },
});

const CLANG =
  /^(.+?):(\d+):(\d+): (fatal error|error|warning|note): (.*?)(?: \[(-W[\w=+-]*|-Werror[\w=,+-]*)\])?$/;
export const clang = diag({
  id: "clang",
  detect: ({ command, text }) =>
    cmdMatches(command, /\b(clang\+?\+?|g\+\+|gcc|cc|c\+\+|make|cmake)\b/) &&
    CLANG.test(text.split("\n").find((l) => CLANG.test(l)) ?? "")
      ? 95
      : share(lines(text), CLANG) > 0.15
        ? 80
        : 0,
  parse(text: string) {
    const { diags, other } = parseBlocks(text, {
      header: CLANG,
      terminal: /^\d+ (warnings?|errors?)( and \d+ (warnings?|errors?))? generated\.$/,
      make: (m) => ({
        severity: m[4] === "warning" ? "warning" : m[4] === "note" ? "note" : "error",
        code: m[6] ?? "",
        message: m[5]!,
        location: `${m[1]}:${m[2]}:${m[3]}`,
      }),
    });
    return { diags, other };
  },
});

const RUFF_FULL = /^([A-Z]+[0-9]+) (?:\[\*\] )?(.*)$/;
const RUFF_LINE = /^(.+?):(\d+):(\d+): ([A-Z]+[0-9]+) (?:\[\*\] )?(.*)$/;
export const ruff = diag({
  id: "ruff",
  detect: ({ command, text }) =>
    cmdMatches(command, /\bruff\b/)
      ? 95
      : /^ --> \S+:\d+:\d+$/m.test(text) && /^Found \d+ errors?\.$/m.test(text)
        ? 85
        : share(lines(text), RUFF_LINE) > 0.5
          ? 75
          : 0,
  parse(text: string) {
    if (share(lines(text), RUFF_LINE) > 0.3) {
      const { diags, other } = parseLineStyle(text, (l) => {
        const m = RUFF_LINE.exec(l);
        return m
          ? { severity: "error", code: m[4]!, message: m[5]!, location: `${m[1]}:${m[2]}:${m[3]}` }
          : null;
      });
      return { diags, other };
    }
    const { diags, other } = parseBlocks(text, {
      header: RUFF_FULL,
      terminal: /^(Found \d+ errors?|\[\*\] \d+ fixable|No fixes available|All checks passed)/,
      make(m, block) {
        const loc = block.map((l) => /^\s*--> (.+)$/.exec(l)?.[1]).find(Boolean);
        return loc ? { severity: "error", code: m[1]!, message: m[2]!, location: loc } : null;
      },
    });
    return { diags, other };
  },
});

const BIOME = /^(\S+?):(\d+):(\d+) (\S+)(?:\s+FIXABLE)?\s+━+$/;
export const biome = diag({
  id: "biome",
  detect: ({ command, text }) =>
    cmdMatches(command, /\bbiome\b/) ? 95 : share(lines(text), BIOME) > 0.03 && /━━━━/.test(text) ? 80 : 0,
  parse(text: string) {
    const { diags, other } = parseBlocks(text, {
      header: BIOME,
      terminal:
        /^(Checked \d+ files?|Found \d+ (errors?|warnings?|infos?)|The number of diagnostics exceeds|Skipped \d+ suggested fixes|If you wish to apply|check ━|lint ━|format ━)/,
      make(m, block) {
        const first = block.find((l) => /^\s+[×!i] /.test(l));
        if (!first) return null;
        const sym = /^\s+([×!i]) /.exec(first)![1];
        return {
          severity: sym === "×" ? "error" : sym === "!" ? "warning" : "info",
          code: m[4]!,
          message: first.trim().slice(2),
          location: `${m[1]}:${m[2]}:${m[3]}`,
        };
      },
    });
    return { diags, other };
  },
});

export const DIAGNOSTIC_EXTRACTORS: Extractor[] = [tsc, mypy, eslint, rustc, clang, ruff, biome];
