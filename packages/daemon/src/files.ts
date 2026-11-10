import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  archiveId,
  countLines,
  countTokens,
  type FileRow,
  languageFor,
  type OutlineClient,
  type OutlineSymbol,
  outline,
  type ProjectStore,
} from "@sieve/core";

/** Files larger than this are never read by Sieve (smart reads pass them through). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Above this, a token count is only taken in the background (never on a hook). */
export const SYNC_TOKEN_BYTES = 64 * 1024;

export interface LoadedFile {
  abs: string;
  rel: string;
  text: string;
  row: FileRow;
}

/** Path relative to the worktree when inside it, else absolute. Always "/"-separated. */
export function relPath(worktree: string, abs: string): string {
  const r = relative(worktree, abs);
  return r.startsWith("..") || isAbsolute(r) ? abs : r.split(sep).join("/");
}

function isBinary(abs: string): boolean {
  const fd = openSync(abs, "r");
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

/**
 * Read a text file and describe it. Returns null for anything that is not a regular,
 * non-binary file under 10 MB. `countAlways` counts tokens even for big files (background).
 */
export function loadFile(
  worktree: string,
  file: string,
  cwd = worktree,
  countAlways = false,
): LoadedFile | null {
  let abs: string;
  let st: ReturnType<typeof statSync>;
  try {
    // Real path: the worktree is resolved through symlinks (macOS /tmp → /private/tmp), so the
    // file must be too, or relative paths and the read history would not line up.
    abs = realpathSync(resolve(cwd, file));
    st = statSync(abs);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > MAX_FILE_BYTES || isBinary(abs)) return null;
  const text = readFileSync(abs, "utf8");
  const rel = relPath(worktree, abs);
  return {
    abs,
    rel,
    text,
    row: {
      size: st.size,
      mtimeMs: Math.floor(st.mtimeMs),
      contentId: archiveId(text),
      lines: countLines(text),
      lang: languageFor(rel),
      tokens: countAlways || st.size <= SYNC_TOKEN_BYTES ? countTokens(text) : null,
    },
  };
}

/**
 * The file's symbols from the index, when the index matches this exact content. Markdown is
 * outlined inline (cheap string work). Never parses code: that happens in the outline worker
 * (see ensureSymbols), so a hook never waits on a parser.
 */
export function symbolsOf(store: ProjectStore, worktree: string, f: LoadedFile): OutlineSymbol[] | null {
  if (!f.row.lang) return null;
  if (f.row.lang === "markdown") return outline(f.rel, f.text);
  const known = store.getFile(worktree, f.rel);
  if (!known || known.contentId !== f.row.contentId) return null;
  const syms = store.symbolsFor(worktree, f.rel);
  return syms.length ? syms : null;
}

/** Parse in the worker if the index has nothing for this content, and record the result. */
export async function ensureSymbols(
  outliner: OutlineClient,
  store: ProjectStore,
  worktree: string,
  f: LoadedFile,
): Promise<OutlineSymbol[] | null> {
  const have = symbolsOf(store, worktree, f);
  if (have || !f.row.lang) return have;
  const syms = await outliner.parse(f.rel, f.text);
  if (syms === null) return null;
  const known = store.getFile(worktree, f.rel);
  store.putFile(
    worktree,
    f.rel,
    { ...f.row, tokens: f.row.tokens ?? (known?.contentId === f.row.contentId ? known.tokens : null) },
    syms,
  );
  return syms;
}
