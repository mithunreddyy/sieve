import type { Extractor } from "./types.ts";
import { compact, plural } from "./util.ts";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};
const decode = (s: string) =>
  s.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(
          e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)),
        )
      : (ENTITIES[e.toLowerCase()] ?? m),
  );
const text = (s: string) =>
  decode(s.replace(/<[^>]+>/g, ""))
    .replace(/[ \t\r\n]+/g, " ")
    .trim();

const ATTR = (name: string) => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
const attr = (tag: string, name: string) => {
  const m = ATTR(name).exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : null;
};

/** End index (exclusive) of the element whose opening tag starts at `start`, balancing nested same-name tags. */
function elementEnd(html: string, start: number, tag: string): number {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[0].endsWith("/>")) continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return html.length;
}

const OPEN = /<([a-z][\w-]*)\b[^>]*>/gi;
/** Ranges of elements matching `pred` on their opening tag. */
function findElements(html: string, pred: (tag: string, open: string) => boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  OPEN.lastIndex = 0;
  for (let m = OPEN.exec(html); m; m = OPEN.exec(html)) {
    if (!pred(m[1]!.toLowerCase(), m[0])) continue;
    const end = elementEnd(html, m.index, m[1]!);
    out.push([m.index, end]);
    OPEN.lastIndex = end;
  }
  return out;
}

const CHROME_TAGS = new Set(["nav", "header", "footer", "aside"]);
const CHROME_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search"]);

/** HTML to readable Markdown: headings, paragraphs, links, lists, code, tables. Scripts, styles and chrome go. */
export function htmlToMarkdown(html: string): { md: string; removed: number } {
  let removed = 0;
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  // Prefer the page's main content when it is marked.
  const main =
    findElements(html, (t, o) => t === "main" || attr(o, "role") === "main")[0] ??
    findElements(html, (t) => t === "article")[0];
  if (main) {
    removed += html.length - (main[1] - main[0]);
    html = html.slice(main[0], main[1]);
  }
  for (const [a, b] of findElements(
    html,
    (t, o) => CHROME_TAGS.has(t) || CHROME_ROLES.has(attr(o, "role") ?? ""),
  ).reverse()) {
    removed += b - a;
    html = html.slice(0, a) + html.slice(b);
  }
  let s = html.replace(/<(script|style|noscript|svg|template|iframe|head|button)\b[\s\S]*?<\/\1>/gi, (m) => {
    removed += m.length;
    return "";
  });
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  const blocks: string[] = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, body: string) => {
    blocks.push(`\n\`\`\`\n${decode(body.replace(/<[^>]+>/g, "")).replace(/\n+$/, "")}\n\`\`\`\n`);
    return `\uE000${blocks.length - 1}\uE001`;
  });
  s = s
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_, n: string, b: string) => `\n\n${"#".repeat(Number(n))} ${text(b).replace(/\s*#$/, "")}\n\n`,
    )
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, open: string, b: string) => {
      const t = text(b);
      const href = attr(open, "href");
      if (!t) return "";
      return href && !href.startsWith("#") && !href.startsWith("javascript:") ? `[${t}](${decode(href)})` : t;
    })
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, b: string) => `\`${text(b)}\``)
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, b: string) => `**${text(b)}**`)
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, b: string) => `*${text(b)}*`)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<tr\b[^>]*>/gi, "\n|")
    .replace(/<\/t[dh]>/gi, " |")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/?(p|div|section|article|ul|ol|table|blockquote|header|footer|nav|main|dl|dt|dd|figure)\b[^>]*>/gi,
      "\n\n",
    )
    .replace(/<[^>]+>/g, "");
  s = decode(s)
    .replace(/\uE000(\d+)\uE001/g, (_, i: string) => blocks[Number(i)]!)
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { md: `${title ? `# ${text(title)}\n\n` : ""}${s}`, removed };
}

export const html: Extractor = {
  id: "html",
  detect: ({ text: t }) =>
    /^\s*(<!doctype html|<html\b)/i.test(t.slice(0, 1000)) ||
    (t.slice(0, 2000).match(/<\/?(div|p|span|a|li|table)\b/gi)?.length ?? 0) > 15
      ? 85
      : 0,
  extract({ text: t, budget }) {
    const { md, removed } = htmlToMarkdown(t);
    let body = md;
    let cut = 0;
    if (Buffer.byteLength(body) > budget) {
      // Long page: keep the start, then an outline of every heading after it.
      const ls = md.split("\n");
      const keep: string[] = [];
      let used = 0;
      let i = 0;
      // Leave room for the outline so the whole body stays within budget.
      for (; i < ls.length && used + ls[i]!.length + 1 <= budget * 0.7; i++) {
        keep.push(ls[i]!);
        used += ls[i]!.length + 1;
      }
      const outline = ls
        .slice(i)
        .filter((l) => /^#{1,6} /.test(l))
        .slice(0, 120);
      cut = ls.length - i;
      body = [
        ...keep,
        "",
        `… ${plural(cut, "more line")} of this page; headings that follow:`,
        ...outline.map((h) => `  ${h}`),
      ].join("\n");
    }
    return {
      extractor: "html",
      body,
      dropped: compact([
        "markup",
        removed > 0 && "scripts and styles",
        cut > 0 && `${plural(cut, "line")} of page text after the first part (headings listed)`,
      ]),
      keptVerbatim: false,
    };
  },
};
