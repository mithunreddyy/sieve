import { GlobalStore, type ProjectRef, ProjectStore, resolveProject } from "@sieve/core";
import { Health } from "./health.ts";
import { BackgroundQueue } from "./queue.ts";

export interface Counters {
  folds: number;
  tokensIn: number;
  tokensOut: number;
}

/** Everything the daemon keeps warm, shared by the hook pipeline and the tool handlers. */
export class DaemonContext {
  readonly global: GlobalStore;
  readonly health: Health;
  readonly queue = new BackgroundQueue();
  readonly counters: Counters = { folds: 0, tokensIn: 0, tokensOut: 0 };
  private stores = new Map<string, ProjectStore>();
  private touched = new Map<string, number>();

  constructor(globalFile?: string) {
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
    return { ref, store };
  }

  close(): void {
    this.health.flush();
    for (const s of this.stores.values()) s.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    for (const s of this.stores.values()) s.close();
    this.stores.clear();
    this.global.close();
  }
}
