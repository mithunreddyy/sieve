import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { archiveId, countTokens, decideRead, initOutlines, outline } from "@sieve/core";

const REPO = resolve(import.meta.dir, "../../..");

export interface ReadRow {
  file: string;
  tokens: number;
  outlineTokens: number;
  savedPct: number;
  symbols: number;
  target: string;
  found: boolean;
}

/** Real, large source files from installed dependencies (deterministic choice: sorted, first N). */
function pickFiles(n: number): string[] {
  const roots = ["zod", "diff", "@modelcontextprotocol/sdk", "smol-toml", "typescript"].flatMap((p) => {
    try {
      const store = join(REPO, "node_modules", ".bun");
      return readdirSync(store)
        .filter((d) => d.startsWith(`${p.replace("/", "+")}@`))
        .map((d) => join(store, d, "node_modules", p));
    } catch {
      return [];
    }
  });
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 6) return;
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory() && e.name !== "node_modules") walk(p, depth + 1);
      else if (/\.(ts|js|mjs)$/.test(e.name) && !/\.(d\.ts|min\.js)$/.test(e.name)) {
        const s = statSync(p).size;
        if (s > 16 * 1024 && s < 400 * 1024) out.push(p);
      }
    }
  };
  // Up to 4 files per package, so one package does not dominate the sample.
  const picked: string[] = [];
  for (const r of roots) {
    const before = out.length;
    walk(r, 0);
    picked.push(...out.slice(before).sort().slice(0, 4));
  }
  return picked.slice(0, n);
}

/**
 * For each file: what a first full read costs, what the outline costs, and whether asking
 * for a symbol from the middle of the file (by name) puts its lines in the outline reply.
 */
export async function runReadBench(n = 20): Promise<ReadRow[]> {
  await initOutlines();
  const rows: ReadRow[] = [];
  for (const abs of pickFiles(n)) {
    const text = readFileSync(abs, "utf8");
    const rel = relative(join(REPO, "node_modules", ".bun"), abs).replace(/^[^/]+\/node_modules\//, "");
    const symbols = outline(abs, text) ?? [];
    const mid = symbols.filter((s) => s.depth === 0 && s.name.length > 4)[
      Math.floor(symbols.filter((s) => s.depth === 0 && s.name.length > 4).length / 2)
    ];
    const tokens = countTokens(text);
    const d = decideRead({
      path: rel,
      text,
      state: { size: Buffer.byteLength(text), mtimeMs: 0, contentId: archiveId(text) },
      tokens,
      last: null,
      lastText: null,
      symbols,
      ...(mid ? { intent: `how does ${mid.name} work` } : {}),
      outlineAboveBytes: 16 * 1024,
      again: "read it again",
      rangeHint: (a, b) => `Read with offset ${a} and limit ${b - a + 1}`,
    });
    const msg = d.kind === "full" ? text : d.message;
    const outlineTokens = countTokens(msg);
    rows.push({
      file: rel,
      tokens,
      outlineTokens,
      savedPct: Math.round((1 - outlineTokens / tokens) * 100),
      symbols: symbols.length,
      target: mid ? `${mid.name} (${mid.startLine}-${mid.endLine})` : "-",
      found: !!mid && msg.includes(`${String(mid.startLine).padStart(6)}│`),
    });
  }
  return rows;
}
