import { readFileSync, realpathSync, statSync } from "node:fs";
import { sep } from "node:path";
import type { ToolOutput } from "@sieve/protocol";

/**
 * Claude Code cuts a large Bash result near 30,000 characters before a hook runs and keeps the whole
 * of it in a file (observed live). Sieve archives the whole result, so errors past the cut are found
 * and `sieve_get` expands any line exactly.
 *
 * The path comes in a hook payload, so it is not trusted: the file must be inside the one folder the
 * adapter derived from the session's transcript path, must be that folder's own regular file (a
 * symlink out of it is refused), must have the size Claude Code reported, must begin with the
 * text the hook received, and must be small enough to read on the hook path. Anything else returns
 * null and the caller archives only what arrived, saying so.
 */

/**
 * Largest persisted result read on the hook path. Reading, masking and archiving it is synchronous
 * (p50 measured at 7 ms for 60 KB, 31 ms for 512 KB, 52 ms for 900 KB; `bun run bench latency`),
 * and every large archive adds indexing and WAL work behind the next hooks. Past this size the
 * result is archived as the partial prefix Claude Code passed on, and the receipt says so.
 */
export const MAX_PERSISTED_BYTES = 256 * 1024;

export type Persisted = NonNullable<ToolOutput["persisted"]>;

export function readPersisted(p: Persisted, received: string): string | null {
  try {
    if (!p.file || !p.dir) return null;
    if (p.totalBytes > MAX_PERSISTED_BYTES) return null;
    const dir = realpathSync(p.dir);
    const file = realpathSync(p.file); // resolves symlinks: a link out of `dir` ends up outside it
    if (!file.startsWith(dir + sep)) return null;
    const st = statSync(file);
    if (!st.isFile() || st.size !== p.totalBytes) return null;
    const text = readFileSync(file, "utf8");
    // Claude Code cuts at a byte count; a cut inside a multi-byte character decodes to a replacement
    // character at the end, which is not in the file.
    const head = received.endsWith("\uFFFD") ? received.slice(0, -1) : received;
    return text.startsWith(head) ? text : null;
  } catch {
    return null;
  }
}
