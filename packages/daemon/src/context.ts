import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Config,
  GlobalStore,
  loadConfig,
  makeReranker,
  OutlineClient,
  PROXY_PROJECT,
  type ProjectRef,
  ProjectStore,
  paths,
  type Reranker,
  resolveProject,
  Skills,
} from "@sieve/core";
import { Guard } from "@sieve/guard";
import { BehaviourWatcher } from "./behaviour.ts";
import { Health } from "./health.ts";
import { BackgroundQueue } from "./queue.ts";
import { ProjectWatcher, type WatcherStatus } from "./watcher.ts";

export interface Counters {
  folds: number;
  tokensIn: number;
  tokensOut: number;
  readsDeclined: number;
  rerunsShortened: number;
  /** Slice-4 bookkeeping (log, recall, state) that failed; the hook reply went out without it. */
  sessionErrors: number;
  /** Tool calls Guard refused or sent to the agent's approval prompt (enforce mode). */
  guardBlocked: number;
  /** Calls Guard would have refused, in monitor mode. */
  guardWouldBlock: number;
  /** Read-only commands declined once and pointed at sieve_run (slice 9). */
  steered: number;
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
  /** Rules, presets and the hash-chained audit log (slice 7). */
  readonly guard: Guard;
  /** Imported skills (slice 8), stored under the Sieve home. */
  readonly skills = new Skills(join(paths.home(), "skills"));
  /** Records what sandboxed runs do, for Guard's behaviour checks (macOS). */
  readonly behaviour = new BehaviourWatcher();
  /** Tree-sitter runs in a worker thread; start() it before relying on outlines. */
  readonly outliner = new OutlineClient();
  readonly counters: Counters = {
    folds: 0,
    tokensIn: 0,
    tokensOut: 0,
    readsDeclined: 0,
    rerunsShortened: 0,
    sessionErrors: 0,
    guardBlocked: 0,
    guardWouldBlock: 0,
    steered: 0,
  };
  /** Reads declined once (key → expiry); the same read repeated before expiry goes through. */
  readonly declines = new Map<string, number>();
  /** Last user prompt per session: the intent for smart reads. */
  readonly lastPrompt = new Map<string, string>();
  /** Staleness already reported (session|context|path → content id or "deleted"). */
  readonly notified = new Map<string, string>();
  /** Archive ids already given as recall pointers, per session (cleared on a new epoch). */
  readonly recalled = new Map<string, Set<string>>();
  /** What the user said recently per session, to check an agent's "asserted" claims (slice 8). */
  readonly userWords = new Map<string, string[]>();
  /** Skills already loaded this epoch, per session: a skill is not repeated unless asked for by name. */
  readonly skillsLoaded = new Map<string, Set<string>>();
  /** Optional search reranker from `[search]` config (slice 12). */
  readonly reranker: Reranker | undefined;
  /** Background work started off the queue (model extraction); tests await it. */
  readonly inflight = new Set<Promise<void>>();
  /** The prompt and log position memory extraction last used, per session (slice 12). */
  readonly extractedFrom = new Map<string, string>();
  readonly extractedSeq = new Map<string, number>();
  /** Fact ids already put in front of the model this epoch, per session. */
  readonly memoryShown = new Map<string, Set<number>>();
  /** Sessions whose core memory block has been delivered this epoch. */
  readonly memoryCoreSent = new Set<string>();
  /** Sessions owed a relevant-facts block on their next prompt (first request, after compaction). */
  readonly memoryDue = new Set<string>();
  /** Sessions whose state block waits for the next prompt (agents that cannot add context at session start). */
  readonly pendingState = new Set<string>();
  /** Notes waiting for a tool result to ride on (agents with no context slot on prompts), per session. */
  readonly pendingNotes = new Map<string, string[]>();
  private stores = new Map<string, ProjectStore>();
  private touched = new Map<string, number>();
  private watchers = new Map<string, ProjectWatcher>();

  constructor(globalFile?: string, config: Config = loadConfig()) {
    this.config = config;
    this.reranker = makeReranker(config.search);
    this.global = new GlobalStore(globalFile, { manualCheckpoint: true });
    this.health = new Health(this.global);
    this.guard = new Guard({ sieveHome: paths.home() });
  }

  private proxy: ProjectStore | null = null;
  /** The proxy's archive, if the proxy has ever run. */
  proxyStore(): ProjectStore | null {
    if (!this.proxy) {
      if (!existsSync(paths.projectDb(PROXY_PROJECT.key))) return null;
      this.proxy = new ProjectStore(PROXY_PROJECT, undefined, { manualCheckpoint: true });
    }
    return this.proxy;
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
    this.behaviour.stop();
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
