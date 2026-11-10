export interface Chunk {
  seq: number;
  title: string;
  body: string;
  startLine: number;
  endLine: number;
  isCode: boolean;
}

export const MAX_CHUNK_BYTES = 4096;

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

interface Block {
  lines: string[];
  start: number; // 1-based
  isCode: boolean;
  path: string[];
}

/**
 * Split text into chunks of at most 4 KB. Markdown headings start a new chunk and give it
 * a title (the heading path). A fenced code block that fits in one chunk is never split.
 * Plain output without headings is cut at line boundaries and titled by line range.
 */
export function chunkText(text: string, fallbackTitle = ""): Chunk[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const blocks = toBlocks(lines);
  const chunks: Chunk[] = [];
  let cur: { lines: string[]; start: number; bytes: number; isCode: boolean; path: string[] } | null = null;

  const flush = () => {
    if (!cur || cur.lines.length === 0) return;
    const end = cur.start + cur.lines.length - 1;
    const where = `lines ${cur.start}-${end}`;
    const head = cur.path.length ? cur.path.join(" > ") : fallbackTitle;
    chunks.push({
      seq: chunks.length,
      title: head ? `${head} (${where})` : where,
      body: cur.lines.join("\n"),
      startLine: cur.start,
      endLine: end,
      isCode: cur.isCode,
    });
    cur = null;
  };

  for (const b of blocks) {
    const bBytes = b.lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
    const headingStart = !b.isCode && HEADING.test(b.lines[0] ?? "");
    if (cur && (headingStart || cur.bytes + bBytes > MAX_CHUNK_BYTES)) flush();
    if (bBytes <= MAX_CHUNK_BYTES) {
      if (!cur) cur = { lines: [], start: b.start, bytes: 0, isCode: b.isCode, path: b.path };
      cur.lines.push(...b.lines);
      cur.bytes += bBytes;
      cur.isCode ||= b.isCode;
      continue;
    }
    // Oversized block: cut at line boundaries; a single huge line is cut by bytes.
    let ln = b.start;
    for (const line of b.lines) {
      let first = true;
      for (const piece of splitLongLine(line)) {
        const pb = Buffer.byteLength(piece) + (first ? 1 : 0);
        if (cur && cur.bytes + pb > MAX_CHUNK_BYTES) flush();
        if (!cur) {
          cur = { lines: [piece], start: ln, bytes: pb, isCode: b.isCode, path: b.path };
        } else if (first) {
          cur.lines.push(piece);
          cur.bytes += pb;
        } else {
          // A continuation of the same source line: no newline was there, so add none.
          cur.lines[cur.lines.length - 1] += piece;
          cur.bytes += pb;
        }
        first = false;
      }
      ln++;
    }
  }
  flush();
  return chunks;
}

function toBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  const path: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (FENCE.test(line)) {
      const fence = FENCE.exec(line)![1]!;
      let j = i + 1;
      while (j < lines.length && !lines[j]!.trimStart().startsWith(fence)) j++;
      const end = Math.min(j, lines.length - 1);
      blocks.push({ lines: lines.slice(i, end + 1), start: i + 1, isCode: true, path: [...path] });
      i = end + 1;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1]!.length;
      path.length = Math.min(path.length, level - 1);
      path[level - 1] = h[2]!;
      for (let k = 0; k < level - 1; k++) path[k] ??= "";
    }
    blocks.push({ lines: [line], start: i + 1, isCode: false, path: path.filter(Boolean) });
    i++;
  }
  return blocks;
}

function splitLongLine(line: string): string[] {
  if (Buffer.byteLength(line) <= MAX_CHUNK_BYTES - 1) return [line];
  const out: string[] = [];
  // Character-based cut is safe for UTF-8 (never splits a code point) and leaves headroom.
  const step = Math.floor((MAX_CHUNK_BYTES - 1) / 4);
  let i = 0;
  while (i < line.length) {
    let end = Math.min(i + step, line.length);
    const c = line.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff && end < line.length) end++; // keep surrogate pairs together
    out.push(line.slice(i, end));
    i = end;
  }
  return out;
}
