import { dirname, join } from "node:path";
import { languageFor, type OutlineSymbol, outline } from "./index.ts";

/**
 * Where the worker script is. From source it sits next to this file. In a compiled binary it
 * is embedded under the bundle root, at its path relative to the build's common root
 * (scripts/build.ts passes it as a second entrypoint).
 */
function workerPath(): string {
  const compiled = Bun.main.startsWith("/$bunfs") || Bun.main.startsWith("B:\\~BUN");
  return compiled
    ? join(dirname(Bun.main), "core", "src", "outline", "worker.js")
    : new URL("./worker.ts", import.meta.url).href;
}

const TIMEOUT_MS = 15_000;

/**
 * Outlines computed in a worker thread. Markdown is done inline (plain string work); code
 * goes to the worker. If the worker is not available, `parse` resolves to null and callers
 * simply have no outline.
 */
export class OutlineClient {
  private worker: Worker | null = null;
  private seq = 0;
  private waiting = new Map<
    number,
    { resolve: (s: OutlineSymbol[] | null) => void; timer: ReturnType<typeof setTimeout> }
  >();
  ready = false;
  error: string | null = null;
  onReady: (() => void) | null = null;
  onError: ((message: string) => void) | null = null;

  private fail(message: string): void {
    this.error = message;
    this.onError?.(message);
  }

  start(): void {
    if (this.worker) return;
    try {
      this.worker = new Worker(workerPath());
    } catch (e) {
      this.fail(`outline worker failed to start: ${(e as Error).message}`);
      return;
    }
    this.worker.onmessage = (e: MessageEvent) => {
      const d = e.data as "ready" | { id: number; symbols: OutlineSymbol[] | null } | { error: string };
      if (d === "ready") {
        if (!this.ready) {
          this.ready = true;
          this.onReady?.();
        }
        return;
      }
      if ("error" in d) {
        this.fail(`outline worker: ${d.error}`);
        return;
      }
      const w = this.waiting.get(d.id);
      if (!w) return;
      clearTimeout(w.timer);
      this.waiting.delete(d.id);
      w.resolve(d.symbols);
    };
    this.worker.onerror = (e) => {
      this.fail(`outline worker error: ${e.message}`);
    };
    // The worker does not keep the daemon alive on its own.
    (this.worker as unknown as { unref?: () => void }).unref?.();
  }

  /** Symbols of a file, or null (unsupported language, worker unavailable, or timeout). */
  parse(path: string, text: string): Promise<OutlineSymbol[] | null> {
    const lang = languageFor(path);
    if (!lang) return Promise.resolve(null);
    if (lang === "markdown") return Promise.resolve(outline(path, text));
    if (!this.worker) return Promise.resolve(null);
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(null);
      }, TIMEOUT_MS);
      this.waiting.set(id, { resolve, timer });
      this.worker!.postMessage({ id, path, text });
    });
  }

  close(): void {
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
    this.waiting.clear();
    this.worker?.terminate();
    this.worker = null;
  }
}
