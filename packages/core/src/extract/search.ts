import { queryTerms } from "../search.ts";
import type { Extractor } from "./types.ts";
import { compact, lines, plural, share } from "./util.ts";

const MATCH = /^(.+?):(\d+)(?::(\d+))?[:-](.*)$/;
const DECL =
  /\b(function\*?|class|interface|type|enum|struct|trait|impl|def|fn|func|module|namespace|protocol|object|record)\s+([A-Za-z_$][\w$]*)|\b(const|let|var|val)\s+([A-Za-z_$][\w$]*)\s*[:=]\s*(async\s*)?(function|\(|[A-Za-z_$][\w$]*\s*=>)|^\s*([A-Za-z_$][\w$]*)\s*[:=]\s*(async\s+)?function\b/;

/** The searched symbol: from the tool's pattern, else the command's first non-flag argument. */
export function searchedName(command?: string, pattern?: string): string | null {
  const pick = (p: string) => {
    const m = /^[\\b^]*([A-Za-z_$][\w$]*)[\\b$]*$/.exec(p.replace(/^['"]|['"]$/g, ""));
    return m ? m[1]! : null;
  };
  if (pattern) return pick(pattern);
  if (!command) return null;
  const parts = command.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
  const i = parts.findIndex((p) => /^(rg|grep|egrep|ag|ack|git)$/.test(p.split("/").pop()!));
  if (i === -1) return null;
  for (const p of parts.slice(i + 1)) {
    if (p === "grep") continue;
    if (p.startsWith("-")) continue;
    return pick(p);
  }
  return null;
}

/**
 * grep / rg results: definitions of the searched name first, then every file with its
 * match count and line numbers, with the first match line (and lines matching the intent)
 * shown per file. Every file and line number stays listed.
 */
export const searchResults: Extractor = {
  id: "search",
  detect: ({ command, toolName, text }) => {
    const sh = share(lines(text), MATCH);
    if (sh < 0.6) return 0;
    return /\b(rg|grep|ag|ack|git grep)\b/.test(command ?? "") || toolName === "Grep" ? 95 : 70;
  },
  extract({ text, command, pattern, intent }) {
    const name = searchedName(command, pattern);
    const terms = intent ? queryTerms(intent).filter((t) => t.length > 2) : [];
    const files = new Map<string, Array<{ line: number; text: string }>>();
    const other: string[] = [];
    for (const l of lines(text)) {
      const m = MATCH.exec(l);
      if (!m) {
        if (l.trim() && l !== "--") other.push(l);
        continue;
      }
      if (!files.has(m[1]!)) files.set(m[1]!, []);
      files.get(m[1]!)!.push({ line: Number(m[2]), text: m[4]! });
    }
    if (!files.size) return null;
    const total = [...files.values()].reduce((n, x) => n + x.length, 0);
    const defs: string[] = [];
    for (const [f, hits] of files) {
      for (const h of hits) {
        const d = DECL.exec(h.text);
        const declared = d ? (d[2] ?? d[4] ?? d[7]) : null;
        // Quoted verbatim, exactly as the tool printed it.
        if (declared && (!name || declared === name)) defs.push(`  ${f}:${h.line}:${h.text}`);
      }
    }
    const out = [
      `${plural(total, "match", "matches")} in ${plural(files.size, "file")}${name ? ` for ${name}` : ""}`,
    ];
    if (defs.length) out.push("", `definitions${name ? ` of ${name}` : ""}:`, ...defs.slice(0, 40));
    // With many files, the file and line-number listing is what fits; sample lines are dropped.
    const samples = files.size <= 120;
    out.push("", `by file (matches: line numbers${samples ? "; first match shown" : ""}):`);
    let shown = 0;
    for (const [f, hits] of files) {
      out.push(`  ${f} (${hits.length}): ${hits.map((h) => h.line).join(", ")}`);
      if (!samples) continue;
      out.push(`      ${hits[0]!.line}: ${hits[0]!.text.trim().slice(0, 160)}`);
      shown++;
      for (const h of hits.slice(1)) {
        const low = h.text.toLowerCase();
        if (terms.length && terms.every((t) => low.includes(t))) {
          out.push(`      ${h.line}: ${h.text.trim().slice(0, 160)}`);
          shown++;
        }
      }
    }
    if (other.length) out.push("", ...other);
    return {
      extractor: "search",
      body: out.join("\n"),
      dropped: compact([
        total - shown > 0 &&
          `the text of ${plural(total - shown, "match line")} (file and line numbers kept)`,
      ]),
      keptVerbatim: false,
    };
  },
};
