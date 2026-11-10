import { spawn } from "node:child_process";
import { type Dirent, existsSync, type FSWatcher, readdirSync, readFileSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import type { OutlineClient, ProjectRef, ProjectStore } from "@sieve/core";
import { loadFile } from "./files.ts";
import type { BackgroundQueue } from "./queue.ts";

/** Directories never indexed or watched for content (git internals are watched separately). */
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".gradle",
  ".idea",
  "vendor",
]);
const STEP = 25;
const DEBOUNCE_MS = 150;

export interface GitEvent {
  /** When git recorded it (the reflog has whole seconds only). */
  at: number;
  /** When this daemon saw it happen; null for the event found at start-up. */
  seenAt: number | null;
  /** The reflog message, e.g. "checkout: moving from main to feature". */
  message: string;
}

export interface WatcherStatus {
  worktree: string;
  files: number;
  symbols: number;
  scanned: boolean;
  lastEventAt: number | null;
  git: GitEvent | null;
  error: string | null;
}

export function ignoredPath(rel: string): boolean {
  return rel.split("/").some((seg) => IGNORED_DIRS.has(seg));
}

/** The worktree's own git dir (HEAD, index, logs) and the shared common dir. */
function gitDirs(worktree: string): { gitDir: string; commonDir: string } | null {
  const dot = join(worktree, ".git");
  if (!existsSync(dot)) return null;
  if (statSync(dot).isDirectory()) return { gitDir: dot, commonDir: dot };
  const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"));
  if (!m) return null;
  const gitDir = m[1]!.trim().startsWith("/") ? m[1]!.trim() : join(worktree, m[1]!.trim());
  const cd = join(gitDir, "commondir");
  const commonDir = existsSync(cd) ? join(gitDir, readFileSync(cd, "utf8").trim()) : gitDir;
  return { gitDir, commonDir };
}

function lastReflog(gitDir: string): GitEvent | null {
  try {
    const log = readFileSync(join(gitDir, "logs", "HEAD"), "utf8").trimEnd();
    const last = log.slice(log.lastIndexOf("\n") + 1);
    const m = /^\S+ \S+ .*? (\d+) [+-]\d{4}\t(.*)$/.exec(last);
    return m ? { at: Number(m[1]) * 1000, seenAt: null, message: m[2]! } : null;
  } catch {
    return null;
  }
}

/**
 * Keeps one worktree's file index (content ids, token counts, outlines) current while an
 * agent works in it. Events are debounced and processed on the background queue in small
 * steps, so watching never delays a hook. Git operations are recorded from the reflog so
 * staleness notes can say what changed a file.
 */
export class ProjectWatcher {
  private fsw: FSWatcher | null = null;
  private gitw: FSWatcher | null = null;
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private allowed: Set<string> | null = null;
  private closed = false;
  readonly git: { dirs: { gitDir: string; commonDir: string } | null; events: GitEvent[] };
  scanned = false;
  lastEventAt: number | null = null;
  lastUsedAt = Date.now();
  error: string | null = null;

  constructor(
    readonly ref: ProjectRef,
    private readonly store: ProjectStore,
    private readonly queue: BackgroundQueue,
    private readonly maxFiles: number,
    private readonly outliner: OutlineClient,
  ) {
    this.git = { dirs: gitDirs(ref.worktree), events: [] };
  }

  start(): void {
    try {
      this.fsw = watch(this.ref.worktree, { recursive: true }, (_ev, name) => {
        if (!name) return;
        const rel = String(name).split("\\").join("/");
        if (rel === ".git" || rel.startsWith(".git/")) return this.onGit(rel.slice(5));
        if (ignoredPath(rel)) return;
        this.pending.add(rel);
        this.schedule();
      });
      this.fsw.on("error", (e) => {
        this.error = String(e);
      });
    } catch (e) {
      this.error = `cannot watch ${this.ref.worktree}: ${(e as Error).message}`;
    }
    // A linked worktree's git dir lives outside the worktree; watch it directly.
    const dirs = this.git.dirs;
    if (dirs && !dirs.gitDir.startsWith(this.ref.worktree)) {
      try {
        this.gitw = watch(dirs.gitDir, { recursive: false }, (_ev, name) => this.onGit(String(name ?? "")));
      } catch {}
    }
    const first = dirs ? lastReflog(dirs.gitDir) : null;
    if (first) this.git.events.push(first);
    this.queue.add("watch-scan", () => this.initialScan());
  }

  private onGit(name: string): void {
    if (!/^(HEAD|ORIG_HEAD|index|packed-refs|logs\/HEAD)$/.test(name)) return;
    const ev = this.git.dirs ? lastReflog(this.git.dirs.gitDir) : null;
    const prev = this.git.events[this.git.events.length - 1];
    if (ev && (!prev || prev.at !== ev.at || prev.message !== ev.message)) {
      this.git.events.push({ ...ev, seenAt: Date.now() });
      if (this.git.events.length > 50) this.git.events.shift();
      // A checkout or reset can change many files at once; recheck every known file.
      for (const p of this.store.knownPaths(this.ref.worktree).keys()) this.pending.add(p);
      this.schedule();
    }
  }

  /**
   * The most recent git operation that happened after `t` (ms), if any. Uses the time this
   * daemon observed it, because the reflog's whole seconds cannot order events within a second.
   */
  gitEventAfter(t: number): GitEvent | null {
    const e = this.git.events[this.git.events.length - 1];
    return e && (e.seenAt ?? e.at) > t ? e : null;
  }

  private schedule(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.lastEventAt = Date.now();
      const batch = [...this.pending];
      this.pending.clear();
      this.enqueue(batch);
    }, DEBOUNCE_MS);
  }

  private enqueue(paths: string[]): void {
    for (let i = 0; i < paths.length; i += STEP) {
      const step = paths.slice(i, i + STEP);
      this.queue.add("watch-update", () => this.update(step));
    }
  }

  /** Bring the index in line with the disk for these paths. Unknown new paths are checked against .gitignore. */
  async update(paths: string[]): Promise<void> {
    if (this.closed) return;
    const known = this.store.knownPaths(this.ref.worktree);
    const fresh = paths.filter((p) => !known.has(p) && !this.allowed?.has(p));
    const ignored = fresh.length ? await this.gitIgnored(fresh) : new Set<string>();
    for (const rel of paths) {
      if (ignored.has(rel)) continue;
      await this.refresh(rel, known.get(rel));
    }
  }

  private async refresh(
    rel: string,
    known?: { size: number; mtimeMs: number; contentId: string },
    force = false,
  ): Promise<void> {
    const abs = join(this.ref.worktree, rel);
    let st: ReturnType<typeof statSync> | null = null;
    try {
      st = statSync(abs);
    } catch {}
    if (!st?.isFile()) {
      if (known) this.store.deleteFile(this.ref.worktree, rel);
      return;
    }
    if (!force && known && known.size === st.size && known.mtimeMs === Math.floor(st.mtimeMs)) return;
    const f = loadFile(this.ref.worktree, abs, this.ref.worktree, true);
    if (!f) return;
    if (!force && known && known.contentId === f.row.contentId) {
      this.store.putFile(this.ref.worktree, rel, f.row); // only the mtime changed
      return;
    }
    // Parsed in the worker. Until it is ready, leave symbols alone rather than recording none.
    const canOutline = !!f.row.lang && (f.row.lang === "markdown" || this.outliner.ready);
    const syms = canOutline ? await this.outliner.parse(rel, f.text) : null;
    this.store.putFile(this.ref.worktree, rel, f.row, syms ?? undefined);
  }

  /** Outline every code file indexed before the parsers finished loading (called once they have). */
  outlineMissing(): void {
    const paths = this.store.filesWithoutSymbols(this.ref.worktree);
    for (let i = 0; i < paths.length; i += STEP) {
      const step = paths.slice(i, i + STEP);
      this.queue.add("watch-outline", async () => {
        for (const p of step) await this.refresh(p, undefined, true);
      });
    }
  }

  private async gitIgnored(paths: string[]): Promise<Set<string>> {
    if (!this.git.dirs) return new Set();
    return new Promise((resolve) => {
      const p = spawn("git", ["check-ignore", "--stdin", "-z"], {
        cwd: this.ref.worktree,
        stdio: ["pipe", "pipe", "ignore"],
      });
      let out = "";
      p.stdout.on("data", (d) => {
        out += d;
      });
      p.on("close", () => resolve(new Set(out.split("\0").filter(Boolean))));
      p.on("error", () => resolve(new Set()));
      p.stdin.end(`${paths.join("\0")}\0`);
    });
  }

  private async listFiles(): Promise<string[]> {
    if (!this.git.dirs) return this.walk();
    return new Promise((resolve) => {
      const p = spawn("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        cwd: this.ref.worktree,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      p.stdout.on("data", (d) => {
        out += d;
      });
      p.on("close", () => resolve(out.split("\0").filter((f) => f && !ignoredPath(f))));
      p.on("error", () => resolve([]));
    });
  }

  /** Outside git: a plain walk, skipping ignored and hidden directories, up to the file cap. */
  private walk(): string[] {
    const out: string[] = [];
    const visit = (dir: string, rel: string) => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= this.maxFiles) return;
        if (e.name.startsWith(".") || IGNORED_DIRS.has(e.name)) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) visit(join(dir, e.name), r);
        else if (e.isFile()) out.push(r);
      }
    };
    visit(this.ref.worktree, "");
    return out;
  }

  /** First pass over the worktree: index every tracked or unignored file, in steps. */
  private async initialScan(): Promise<void> {
    const files = (await this.listFiles()).slice(0, this.maxFiles);
    this.allowed = new Set(files);
    const known = this.store.knownPaths(this.ref.worktree);
    for (const p of known.keys()) if (!this.allowed.has(p)) this.pending.add(p); // deleted since last time
    this.enqueue(files);
    this.queue.add("watch-scan-done", () => {
      this.scanned = true;
    });
    if (this.pending.size) this.schedule();
  }

  status(): WatcherStatus {
    return {
      worktree: this.ref.worktree,
      files: this.store.fileCount(this.ref.worktree),
      symbols: this.store.symbolCount(this.ref.worktree),
      scanned: this.scanned,
      lastEventAt: this.lastEventAt,
      git: this.git.events[this.git.events.length - 1] ?? null,
      error: this.error,
    };
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.fsw?.close();
    this.gitw?.close();
  }
}
