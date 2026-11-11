import { spawnSync } from "node:child_process";

/**
 * Local re-ranking for search (slice 12). Full-text search finds candidates by words; a reranker
 * reorders those candidates by how close each is to the query *as a whole*, and its order is fused
 * with the lexical one (reciprocal rank fusion), so a strong lexical match is never thrown away.
 *
 * Two providers, both local:
 *  - "hash": hashed word and character-n-gram vectors. No model file, no download, deterministic,
 *    microseconds per chunk. It captures shared sub-words and word forms ("limiter" ~ "limiting"),
 *    NOT meaning: it will not connect "car" with "automobile". Called what it is.
 *  - "command": a program you name embeds the texts (stdin: JSON {texts}, stdout: JSON {vectors}),
 *    so a neural model you run yourself (sentence-transformers, llama.cpp, ollama) can plug in.
 *    Sieve ships no model.
 */

export type Vector = Float32Array;
export interface Candidate {
  id: number;
  text: string;
}
/** Similarity of each candidate to the query, higher is closer. Candidates may be missing from the result. */
export type Reranker = (query: string, candidates: Candidate[]) => Map<number, number>;

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const WORD = /[\p{L}\p{N}_]+/gu;

/** Split identifiers like `refreshLimiter` / `refresh_limiter` into their parts. */
function words(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(WORD) ?? []) {
    out.push(raw.toLowerCase());
    const parts = raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_]+/);
    if (parts.length > 1) for (const p of parts) if (p.length > 1) out.push(p.toLowerCase());
  }
  return out;
}

export function hashEmbed(text: string, dims = 512): Vector {
  const v = new Float32Array(dims);
  const bump = (feature: string, weight: number) => {
    const h = fnv(feature);
    v[h % dims] = (v[h % dims] ?? 0) + (h & 0x80000000 ? -weight : weight);
  };
  const counts = new Map<string, number>();
  for (const w of words(text.slice(0, 20_000))) counts.set(w, (counts.get(w) ?? 0) + 1);
  for (const [w, c] of counts) {
    const tf = 1 + Math.log(c);
    bump(`w:${w}`, 1.5 * tf);
    if (w.length >= 4) {
      const p = `^${w}$`;
      for (let n = 3; n <= 4; n++)
        for (let i = 0; i + n <= p.length; i++) bump(`g${n}:${p.slice(i, i + n)}`, 0.5 * tf);
    }
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

export function cosine(a: Vector, b: Vector): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

export const hashReranker: Reranker = (query, candidates) => {
  const q = hashEmbed(query);
  return new Map(candidates.map((c) => [c.id, cosine(q, hashEmbed(c.text))]));
};

/** A reranker backed by a program you run. Any failure returns an empty map, i.e. no reordering. */
export function commandReranker(cmd: string[], timeoutMs = 10_000): Reranker {
  return (query, candidates) => {
    const [bin, ...args] = cmd;
    if (!bin) return new Map();
    const r = spawnSync(bin, args, {
      input: JSON.stringify({ texts: [query, ...candidates.map((c) => c.text.slice(0, 4000))] }),
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (r.status !== 0) return new Map();
    try {
      const vectors = (JSON.parse(r.stdout) as { vectors?: number[][] }).vectors;
      if (!Array.isArray(vectors) || vectors.length !== candidates.length + 1) return new Map();
      const q = Float32Array.from(vectors[0]!);
      const nq = Math.sqrt(q.reduce((s, x) => s + x * x, 0)) || 1;
      return new Map(
        candidates.map((c, i) => {
          const d = Float32Array.from(vectors[i + 1]!);
          const nd = Math.sqrt(d.reduce((s, x) => s + x * x, 0)) || 1;
          return [c.id, cosine(q, d) / (nq * nd)];
        }),
      );
    } catch {
      return new Map();
    }
  };
}

export function makeReranker(cfg: {
  rerank: "off" | "hash" | "command";
  command: string[];
}): Reranker | undefined {
  if (cfg.rerank === "hash") return hashReranker;
  if (cfg.rerank === "command" && cfg.command.length) return commandReranker(cfg.command);
  return undefined;
}
