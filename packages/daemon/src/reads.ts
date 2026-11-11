import {
  decideRead,
  formatInt,
  type OutlineSymbol,
  type ProjectRef,
  type ProjectStore,
  type ReadDecision,
  type ReaderRef,
} from "@sieve/core";
import type { DaemonContext } from "./context.ts";
import { ensureSymbols, type LoadedFile, loadFile, SYNC_TOKEN_BYTES, symbolsOf } from "./files.ts";

/** Hooks never load files larger than this; the read passes through untouched. */
const HOOK_MAX_BYTES = 2 * 1024 * 1024;
/** A declined read may be repeated within this time and then goes through. */
const DECLINE_TTL_MS = 30 * 60_000;

export interface Hints {
  again: string;
  range: (from: number, to: number) => string;
}

const declineKey = (r: ReaderRef, f: LoadedFile) => `${r.sessionId}|${r.context}|${f.rel}|${f.row.contentId}`;

/**
 * PreToolUse of a full read. Returns a message to decline the read with (once), or null to
 * let it through. Declines only when Sieve has something shorter that is still correct for
 * this reader: "unchanged", the changed hunks, or an outline of a large file.
 */
export function smartReadBefore(
  ctx: DaemonContext,
  store: ProjectStore,
  ref: ProjectRef,
  reader: ReaderRef,
  path: string,
  cwd: string,
  hints: Hints,
  opts: { trustHistory?: boolean } = {},
): string | null {
  if (!ctx.config.reads.smart) return null;
  const f = loadFile(ref.worktree, path, cwd);
  if (!f || f.row.size > HOOK_MAX_BYTES) return null;
  const key = declineKey(reader, f);
  const until = ctx.declines.get(key);
  if (until !== undefined) {
    ctx.declines.delete(key);
    if (until > Date.now()) return null; // asked again: give the whole file
  }
  const d = decide(ctx, store, ref, reader, f, hints, undefined, undefined, opts.trustHistory !== false);
  if (d === null) {
    // A large source file that is not indexed yet: let this read through and outline it in
    // the worker, so the next read of it is smart. A hook never waits on a parser.
    ctx.queue.add("outline", () => ensureSymbols(ctx.outliner, store, ref.worktree, f).then(() => undefined));
    return null;
  }
  if (d.kind === "full") return null;
  ctx.declines.set(key, Date.now() + DECLINE_TTL_MS);
  return d.message;
}

/**
 * The read decision, or null when a large file in a supported language has no symbols yet
 * and nothing else applies (callers then send the file and index it in the background).
 */
function decide(
  ctx: DaemonContext,
  store: ProjectStore,
  ref: ProjectRef,
  reader: ReaderRef,
  f: LoadedFile,
  hints: Hints,
  intent?: string,
  preParsed?: OutlineSymbol[] | null,
  trustHistory = true,
): ReadDecision | null {
  // Without trusted history every read is treated as a first read: an outline for a large
  // file, otherwise the file. Never "unchanged" or only-the-changed-hunks.
  const last = trustHistory ? store.lastRead(reader, ref.worktree, f.rel) : null;
  const lastText =
    last && last.contentId !== f.row.contentId ? (store.get(last.contentId)?.text ?? null) : null;
  const big = f.row.size > ctx.config.reads.outline_above_kb * 1024;
  const known = store.getFile(ref.worktree, f.rel);
  const tokens = f.row.tokens ?? (known?.contentId === f.row.contentId ? known.tokens : null);
  const prompt = intent ?? ctx.lastPrompt.get(reader.sessionId);
  const symbols = big ? (preParsed ?? symbolsOf(store, ref.worktree, f)) : null;
  const knowsIt = last && (last.kind === "full" || last.kind === "edit");
  if (big && symbols === null && f.row.lang && f.row.lang !== "markdown" && !knowsIt) return null;
  return decideRead({
    path: f.rel,
    // The archived earlier version has its secrets masked; compare like with like, or every
    // line holding a secret would show up as changed.
    text: lastText === null ? f.text : store.mask(f.text, ref.worktree),
    state: f.row,
    tokens,
    last,
    lastText,
    symbols,
    ...(prompt ? { intent: prompt } : {}),
    outlineAboveBytes: ctx.config.reads.outline_above_kb * 1024,
    again: hints.again,
    rangeHint: hints.range,
  });
}

/** Archive the file's content (for later diffs and search) and record what this reader now knows. */
export function recordRead(
  ctx: DaemonContext,
  store: ProjectStore,
  ref: ProjectRef,
  reader: ReaderRef,
  path: string,
  cwd: string,
  kind: "full" | "partial" | "edit" | "outline",
  agent: string,
): number | null {
  const f = loadFile(ref.worktree, path, cwd);
  if (!f) return null;
  const n = store.recordRead(reader, ref.worktree, f.rel, kind, f.row);
  const archive = () => {
    const item = store.put(f.text, {
      sessionId: reader.sessionId,
      worktree: ref.worktree,
      agent,
      sourceKind: "read",
      source: f.rel,
    });
    if (item.isNew) ctx.indexLater(store, item.id);
  };
  // Archiving counts tokens; for big files do it in the background, never on the hook.
  if (f.row.size <= SYNC_TOKEN_BYTES) archive();
  else ctx.queue.add("archive-read", archive);
  if (kind !== "partial") ctx.notified.delete(`${reader.sessionId}|${reader.context}|${f.rel}`);
  return n;
}

/**
 * Files this reader read (or edited) in the current epoch that changed on disk since, and
 * that it has not been told about yet. Returns a short note for the next prompt, or null.
 */
export function staleNotice(
  ctx: DaemonContext,
  store: ProjectStore,
  ref: ProjectRef,
  reader: ReaderRef,
): string | null {
  const reads = store.readsInEpoch(reader, ref.worktree, 200).filter((r) => r.kind !== "outline");
  const changed: string[] = [];
  let more = 0;
  for (const r of reads) {
    const nk = `${reader.sessionId}|${reader.context}|${r.path}`;
    let now: string;
    const f = loadFile(ref.worktree, r.path);
    if (!f) {
      now = "deleted";
    } else if (f.row.size === r.size && f.row.mtimeMs === r.mtimeMs) continue;
    else if (f.row.contentId === r.contentId) continue;
    else now = f.row.contentId;
    if (ctx.notified.get(nk) === now) continue;
    ctx.notified.set(nk, now);
    if (changed.length >= 10) {
      more++;
      continue;
    }
    const git = ctx.watcher(ref)?.gitEventAfter(r.createdAt);
    const what = now === "deleted" ? "deleted" : "changed";
    changed.push(`${r.path} (${what}${git ? `, after git: ${git.message}` : ""})`);
  }
  if (!changed.length) return null;
  return `[sieve] Since you read them, these files changed on disk (not by your edits): ${changed.join("; ")}${more ? `; and ${more} more` : ""}. Read them again before relying on what you saw.`;
}

/** The sieve_read MCP tool. */
export async function readTool(
  ctx: DaemonContext,
  store: ProjectStore,
  ref: ProjectRef,
  reader: ReaderRef,
  cwd: string,
  args: { path: string; intent?: string; ranges?: string[]; full?: boolean },
): Promise<{ text: string; isError: boolean }> {
  const f = loadFile(ref.worktree, args.path, cwd);
  if (!f)
    return {
      text: `Cannot read ${args.path}: not a regular text file under 10 MB, or it does not exist.`,
      isError: true,
    };
  const lines = f.text.split("\n");
  const numbered = (from: number, to: number) =>
    lines
      .slice(from - 1, to)
      .map((l, k) => `${String(from + k).padStart(6)}│ ${l}`)
      .join("\n");
  if (args.ranges?.length) {
    const parts = args.ranges
      .map((r) => r.split("-").map(Number) as [number, number])
      .map(([a, b]) => `lines ${a}-${Math.min(b, lines.length)} of ${f.rel}:\n${numbered(a, b)}`);
    recordRead(ctx, store, ref, reader, f.abs, cwd, "partial", "mcp");
    return { text: parts.join("\n"), isError: false };
  }
  const hints: Hints = {
    again: 'call sieve_read with "full": true',
    range: (a, b) => `Call sieve_read with "ranges": ["${a}-${b}"]`,
  };
  if (!args.full) {
    const big = f.row.size > ctx.config.reads.outline_above_kb * 1024;
    const syms = big ? await ensureSymbols(ctx.outliner, store, ref.worktree, f) : null;
    const d = decide(ctx, store, ref, reader, f, hints, args.intent, syms);
    if (d && d.kind !== "full") {
      if (d.kind === "outline") store.recordRead(reader, ref.worktree, f.rel, "outline", f.row);
      return { text: d.message, isError: false };
    }
  }
  const CAP = 100 * 1024;
  let end = lines.length;
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    used += Buffer.byteLength(lines[i]!) + 9;
    if (used > CAP) {
      end = i;
      break;
    }
  }
  const whole = end >= lines.length;
  recordRead(ctx, store, ref, reader, f.abs, cwd, whole ? "full" : "partial", "mcp");
  const tail = whole
    ? ""
    : `\n[sieve] showing lines 1-${end} of ${lines.length}. Continue: sieve_read {"path":"${args.path}","ranges":["${end + 1}-${lines.length}"]}`;
  return { text: `${f.rel} (${formatInt(lines.length)} lines)\n${numbered(1, end)}${tail}`, isError: false };
}
