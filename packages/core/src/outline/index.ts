import { byteLength } from "../text.ts";
import { CORE_WASM, GRAMMAR_FILES, type GrammarId } from "./grammars.ts";
import { kindOf, languageFor, QUERIES } from "./languages.ts";

export { languageFor } from "./languages.ts";

export interface OutlineSymbol {
  name: string;
  kind: string;
  startLine: number; // 1-based
  endLine: number;
  depth: number;
  /** Name path of enclosing symbols, e.g. "Router" for a method of Router. */
  parent: string;
  /** First line of the declaration, trimmed, at most 160 characters. */
  signature: string;
}

// web-tree-sitter types, kept local so the rest of the code does not depend on them.
interface TSNode {
  type: string;
  text: string;
  parent: TSNode | null;
  childForFieldName(name: string): TSNode | null;
  startPosition: { row: number };
  endPosition: { row: number };
}
interface TSQuery {
  matches(node: TSNode): Array<{ captures: Array<{ name: string; node: TSNode }> }>;
}
interface TSParser {
  setLanguage(l: unknown): void;
  parse(src: string): { rootNode: TSNode; delete(): void } | null;
}

let ready: Promise<void> | null = null;
/** Set only after every grammar has loaded; a partially loaded set must not look ready. */
let loaded = false;
let parser: TSParser | null = null;
const langs = new Map<GrammarId, { language: unknown; queries: TSQuery[] }>();
/** Files larger than this are not parsed (outline falls back to "no symbols"). */
export const MAX_PARSE_BYTES = 2 * 1024 * 1024;

const bytes = async (p: string) => new Uint8Array(await Bun.file(p).arrayBuffer());

/** Load the tree-sitter runtime and every grammar. Idempotent; the daemon calls it at start. */
export function initOutlines(): Promise<void> {
  ready ??= (async () => {
    const mod = (await import("@vscode/tree-sitter-wasm")) as unknown as {
      default?: Record<string, unknown>;
    } & Record<string, unknown>;
    const TS = (mod.default ?? mod) as {
      Parser: { init(o: unknown): Promise<void>; new (): TSParser };
      Language: { load(b: Uint8Array): Promise<unknown> };
      Query: new (l: unknown, s: string) => TSQuery;
    };
    await TS.Parser.init({ wasmBinary: await bytes(CORE_WASM) });
    parser = new TS.Parser();
    for (const [id, file] of Object.entries(GRAMMAR_FILES) as Array<[GrammarId, string]>) {
      const language = await TS.Language.load(await bytes(file));
      const queries: TSQuery[] = [];
      for (const src of QUERIES[id]) {
        try {
          queries.push(new TS.Query(language, src));
        } catch {
          // This grammar has no such node type; skip the pattern.
        }
      }
      langs.set(id, { language, queries });
    }
    loaded = true;
  })();
  return ready;
}

export const outlinesReady = () => loaded;

function nest(raw: Array<Omit<OutlineSymbol, "depth" | "parent">>): OutlineSymbol[] {
  const sorted = raw.sort(
    (a, b) => a.startLine - b.startLine || b.endLine - a.endLine || a.name.localeCompare(b.name),
  );
  const out: OutlineSymbol[] = [];
  const stack: OutlineSymbol[] = [];
  const seen = new Set<string>();
  for (const s of sorted) {
    const key = `${s.startLine}:${s.endLine}:${s.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    while (stack.length && stack[stack.length - 1]!.endLine < s.startLine) stack.pop();
    const sym = { ...s, depth: stack.length, parent: stack.map((x) => x.name).join(".") };
    out.push(sym);
    if (s.endLine > s.startLine) stack.push(sym);
  }
  return out;
}

/** Kind of a declaration; for `const x = …` it comes from the value (function, class, or const). */
function declaredKind(def: TSNode, name: TSNode): string {
  if (
    def.type !== "lexical_declaration" &&
    def.type !== "variable_declaration" &&
    def.type !== "export_statement"
  ) {
    return kindOf(def.type);
  }
  const value = name.parent?.childForFieldName("value");
  if (value && /^(arrow_function|function_expression|function|generator_function)$/.test(value.type))
    return "function";
  if (value && /^class/.test(value.type)) return "class";
  return "const";
}

function markdownOutline(text: string): OutlineSymbol[] {
  const lines = text.split("\n");
  const heads: Array<{ level: number; name: string; line: number }> = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const m = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) heads.push({ level: m[1]!.length, name: m[2]!, line: i + 1 });
  });
  return nest(
    heads.map((h, i) => {
      const next = heads.slice(i + 1).find((x) => x.level <= h.level);
      return {
        name: h.name,
        kind: `h${h.level}`,
        startLine: h.line,
        endLine: next ? next.line - 1 : lines.length,
        signature: `${"#".repeat(h.level)} ${h.name}`.slice(0, 160),
      };
    }),
  );
}

/**
 * Symbols of a file with their line ranges. Returns null when the language is not supported
 * or the runtime has not finished loading (callers then fall back or retry later).
 */
export function outline(path: string, text: string): OutlineSymbol[] | null {
  const lang = languageFor(path);
  if (!lang) return null;
  if (lang === "markdown") return markdownOutline(text);
  const l = langs.get(lang);
  if (!loaded || !parser || !l || byteLength(text) > MAX_PARSE_BYTES) return null;
  parser.setLanguage(l.language);
  const tree = parser.parse(text);
  if (!tree) return null;
  const lines = text.split("\n");
  const raw: Array<Omit<OutlineSymbol, "depth" | "parent">> = [];
  try {
    for (const q of l.queries) {
      for (const m of q.matches(tree.rootNode)) {
        const def = m.captures.find((c) => c.name === "def")?.node;
        const name = m.captures.find((c) => c.name === "name")?.node;
        if (!def || !name) continue;
        const start = def.startPosition.row + 1;
        raw.push({
          name: name.text.split("\n")[0]!.slice(0, 120),
          kind: declaredKind(def, name),
          startLine: start,
          endLine: def.endPosition.row + 1,
          signature: (lines[start - 1] ?? "").trim().slice(0, 160),
        });
      }
    }
  } finally {
    tree.delete();
  }
  return nest(raw);
}
