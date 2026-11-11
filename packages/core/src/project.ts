import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { sha256Hex } from "./ids.ts";

export interface ProjectRef {
  /** Stable key shared by every worktree of one repo. */
  key: string;
  /** Main worktree root (or the directory itself outside git). */
  root: string;
  name: string;
  /** Root of the worktree this path is in. */
  worktree: string;
}

/** The archive behind the local proxy (slice 10): a project of its own, so `sieve_get` can expand what it archived. */
export const PROXY_PROJECT: ProjectRef = { key: "proxy", root: "", name: "proxy", worktree: "" };

const cache = new Map<string, { ref: ProjectRef; at: number }>();
const CACHE_MS = 60_000; // re-check now and then, so a later `git init` is picked up

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Resolve the project for a directory using only the filesystem (no `git` process, so it
 * stays well inside the hook budget). Worktrees are linked to their repo through the
 * `.git` file's `gitdir:` line and the `commondir` file.
 */
export function resolveProject(cwd: string): ProjectRef {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.ref;
  const start = real(cwd);
  let dir = start;
  let ref: ProjectRef | undefined;
  for (;;) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      const commonDir = gitCommonDir(dotGit);
      if (commonDir) {
        const root = basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
        ref = { key: sha256Hex(commonDir).slice(0, 16), root, name: basename(root), worktree: dir };
      }
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  ref ??= { key: sha256Hex(start).slice(0, 16), root: start, name: basename(start) || "/", worktree: start };
  if (cache.size > 1000) cache.clear();
  cache.set(cwd, { ref, at: Date.now() });
  return ref;
}

function gitCommonDir(dotGit: string): string | null {
  try {
    if (statSync(dotGit).isDirectory()) return real(dotGit);
    const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    if (!m?.[1]) return null;
    const gitDir = isAbsolute(m[1]) ? m[1] : resolve(dirname(dotGit), m[1]);
    const commonFile = join(gitDir, "commondir");
    if (existsSync(commonFile)) {
      const rel = readFileSync(commonFile, "utf8").trim();
      return real(isAbsolute(rel) ? rel : resolve(gitDir, rel));
    }
    return real(gitDir);
  } catch {
    return null;
  }
}
