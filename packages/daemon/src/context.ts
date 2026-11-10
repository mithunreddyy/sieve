import {
  type Config,
  GlobalStore,
  loadConfig,
  OutlineClient,
  type ProjectRef,
  ProjectStore,
  resolveProject,
} from "@sieve/core";
import { Health } from "./health.ts";
import { BackgroundQueue } from "./queue.ts";
import { ProjectWatcher, type WatcherStatus } from "./watcher.ts";

export interface Counters {
  folds: number;
  tokensIn: number;
  tokensOut: number;
  readsDeclined: number;
  rerunsShortened: number;
}

/** At most this many worktrees are watched at once; the least recently used is closed. */
const MAX_WATCHERS = 20;
/** A worktree no agent has touched for this long stops being watched. */
const WATCH_IDLE_MS = 2 * 3600_000;

/** Everything the daemon keeps warm, shared by the hook pipeline and the tool handlers. */
export class DaemonContext {
  readonly global: GlobalStore;
  readonly health: Health;
  readonly config: Config;
  readonly queue = new BackgroundQueue();
  /** Tree-sitter runs in a worker thread; start() it before relying on outlines. */
  readonly outliner = new OutlineClient();
  readonly counters: Counters = { folds: 0, tokensIn: 0, tokensOut: 0, readsDeclined: 0, rerunsShortened: 0 };
  /** Reads declined once (key → expiry); the same read repeated before expiry goes through. */
  readonly declines = new Map<string, number>();
  /** Last user prompt per session: the intent for smart reads. */
  readonly lastPrompt = new Map<string, string>();
  /** Staleness already reported (session|context|path → content id or "deleted"). */
  readonly notified = new Map<string, string>();
  private stores = new Map<string, ProjectStore>();
  private touched = new Map<string, number>();
  private watchers = new Map<string, ProjectWatcher>();

  constructor(globalFile?: string, config: Config = loadConfig()) {
    this.config = config;
    this.global = new GlobalStore(globalFile, { manualCheckpoint: true });
    this.health = new Health(this.global);
  }

  /** Index an item in small steps on the background queue, so hooks never wait long behind it. */
  indexLater(store: ProjectStore, id: string): void {
    this.queue.add("index", () => {
      if (!store.indexStep(id).done) this.indexLater(store, id);
    });
  }

  /** Checkpoint every open database's WAL (runs on the background queue). */
  checkpointAll(): void {
    for (const s of this.stores.values()) s.checkpoint();
    this.global.checkpoint();
  }

  project(cwd: string): { ref: ProjectRef; store: ProjectStore } {
    const ref = resolveProject(cwd);
    let store = this.stores.get(ref.key);
    if (!store) {
      store = new ProjectStore(ref, undefined, { manualCheckpoint: true });
      this.stores.set(ref.key, store);
    }
    const now = Date.now();
    if ((this.touched.get(ref.key) ?? 0) < now - 60_000) {
      this.touched.set(ref.key, now);
      this.queue.add("touch-project", () => this.global.touchProject(ref, now));
    }
    this.ensureWatcher(ref, store);
    return { ref, store };
  }

  /** The watcher for a worktree, if one is running. */
  watcher(ref: ProjectRef): ProjectWatcher | undefined {
    return this.watchers.get(ref.worktree);
  }

  private ensureWatcher(ref: ProjectRef, store: ProjectStore): void {
    if (!this.config.watch.enabled) return;
    const w = this.watchers.get(ref.worktree);
    if (w) {
      w.lastUsedAt = Date.now();
      return;
    }
    if (this.watchers.size >= MAX_WATCHERS) {
      const oldest = [...this.watchers.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0]!;
      oldest.close();
      this.watchers.delete(oldest.ref.worktree);
    }
    const nw = new ProjectWatcher(ref, store, this.queue, this.config.watch.max_files, this.outliner);
    this.watchers.set(ref.worktree, nw);
    nw.start();
  }

  /** Stop watching worktrees nobody has used for a while (maintenance tick). */
  closeIdleWatchers(now = Date.now()): void {
    for (const [k, w] of this.watchers) {
      if (now - w.lastUsedAt > WATCH_IDLE_MS) {
        w.close();
        this.watchers.delete(k);
      }
    }
    for (const [k, until] of this.declines) if (until < now) this.declines.delete(k);
  }

  /** The tree-sitter parsers just finished loading: outline what was indexed before. */
  outlinesLoaded(): void {
    for (const w of this.watchers.values()) w.outlineMissing();
  }

  watcherStatus(): WatcherStatus[] {
    return [...this.watchers.values()].map((w) => w.status());
  }

  close(): void {
    this.queue.stop();
    this.outliner.close();
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    this.health.flush();
    for (const s of this.stores.values()) s.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    for (const s of this.stores.values()) s.close();
    this.stores.clear();
    this.global.close();
  }
}
