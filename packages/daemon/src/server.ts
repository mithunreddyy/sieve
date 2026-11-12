import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { basename, join } from "node:path";
import { paths, warmTokenizer } from "@sieve/core";
import {
  PROTOCOL_VERSION,
  type ReplyFrame,
  RequestFrame,
  SIEVE_VERSION,
  type StatusReport,
} from "@sieve/protocol";
import { DaemonContext } from "./context.ts";
import { readMisses } from "./health.ts";
import { Jobs } from "./jobs.ts";
import { handleHook, replayHook } from "./pipeline.ts";
import { callTool, ToolError } from "./tools.ts";

export interface DaemonOptions {
  socketPath?: string;
  lockPath?: string;
  /** Minutes without requests before exiting; 0 = never. */
  idleMinutes?: number;
  /** Interval of the maintenance tick (health flush; WAL checkpoint every second tick). Default 5000. */
  maintenanceMs?: number;
  /** Longest a shutdown may take before the process exits anyway (default 30 s). */
  shutdownMs?: number;
  log?: (msg: string) => void;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Take the single-instance lock. Returns false if a live daemon already holds it. */
export function acquireLock(lock: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(readFileSync(lock, "utf8").trim());
      if (Number.isFinite(pid) && pid > 0 && (pid === process.pid || pidAlive(pid))) return false;
      try {
        unlinkSync(lock); // stale: its owner is gone
      } catch {}
    }
  }
  return false;
}

export class Daemon {
  readonly ctx: DaemonContext;
  readonly jobs = new Jobs();
  private server: Server | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private notifyTimer: ReturnType<typeof setInterval> | null = null;
  private readonly startedAt = Date.now();
  private readonly socketPath: string;
  private readonly lockPath: string;
  private readonly idleMs: number;
  private readonly maintenanceMs: number;
  private readonly shutdownMs: number;
  private readonly notifyMs = 10 * 60_000;
  private stopping = false;
  private exited = false;
  /** The socket file's inode: if it disappears or is replaced, this daemon is no longer reachable. */
  private socketIno = -1;
  private readonly sockets = new Set<Socket>();
  private inflight = 0;
  private log: (msg: string) => void;
  onStop: (() => void) | null = null;

  constructor(opts: DaemonOptions = {}) {
    this.socketPath = opts.socketPath ?? paths.socket();
    this.lockPath = opts.lockPath ?? paths.lock();
    const idle = opts.idleMinutes ?? Number(process.env.SIEVE_IDLE_MINUTES ?? 30);
    this.idleMs = Number.isFinite(idle) && idle > 0 ? idle * 60_000 : 0;
    this.maintenanceMs = opts.maintenanceMs ?? 5000;
    this.shutdownMs = opts.shutdownMs ?? 30_000;
    this.log = opts.log ?? ((m) => console.error(`[sieved ${new Date().toISOString()}] ${m}`));
    this.ctx = new DaemonContext();
  }

  /** Start listening. Resolves false if another daemon is already running. */
  async start(): Promise<boolean> {
    mkdirSync(paths.runDir(), { recursive: true, mode: 0o700 });
    chmodSync(paths.runDir(), 0o700);
    if (!acquireLock(this.lockPath)) return false;
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath); // we hold the lock, so it is stale
    warmTokenizer();
    // Tree-sitter runs in a worker; once its grammars are loaded, outline what was missed.
    this.ctx.outliner.onReady = () => this.ctx.outlinesLoaded();
    this.ctx.outliner.onError = (m) => this.log(m);
    this.ctx.outliner.start();
    let ticks = 0;
    this.server = createServer((sock) => this.accept(sock));
    await new Promise<void>((res, rej) => {
      this.server!.once("error", rej);
      this.server!.listen(this.socketPath, () => res());
    });
    chmodSync(this.socketPath, 0o600);
    this.socketIno = statSync(this.socketPath).ino;
    this.flushTimer = setInterval(() => {
      // Nobody can reach a daemon whose socket file was deleted (SIEVE_HOME removed) or replaced:
      // stop instead of lingering until the idle timeout.
      if (!this.ownsSocket()) {
        this.log("socket file is gone or replaced; stopping");
        void this.stop();
        return;
      }
      this.ctx.queue.add("flush-health", () => this.ctx.health.flush());
      // Auto-checkpoint is off in the daemon (see OpenOptions.manualCheckpoint); do it here, every 10 s.
      ticks++;
      this.ctx.closeIdleWatchers();
      this.ctx.maybeRetention();
      if (ticks % 2 === 0) this.ctx.queue.add("checkpoint", () => this.ctx.checkpointAll());
    }, this.maintenanceMs);
    this.flushTimer.unref?.();
    // Optional (off by default): every 10 minutes ask the sieve binary whether an installed agent
    // has stopped pointing at Sieve, and notify once if so. A child process: nothing runs on the hook path.
    const bin =
      process.env.SIEVE_BIN || (basename(process.execPath).startsWith("sieve") ? process.execPath : "");
    if (this.ctx.config.notify.enabled && bin) {
      this.notifyTimer = setInterval(() => {
        try {
          spawn(bin, ["notify-check"], { stdio: "ignore", detached: false, env: process.env }).on(
            "error",
            () => {},
          );
        } catch {}
      }, this.notifyMs);
      this.notifyTimer.unref?.();
    }
    this.touch();
    this.replaySpool();
    this.log(`listening on ${this.socketPath} (pid ${process.pid}, v${SIEVE_VERSION})`);
    return true;
  }

  private touch(): void {
    if (!this.idleMs) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.jobs.active > 0) return this.touch();
      this.log("idle timeout, shutting down");
      void this.stop();
    }, this.idleMs);
  }

  /**
   * Frames the shim kept while no daemon was running (run/spool, one per file, named by nanosecond time):
   * a fresh session start or prompt is replayed, anything else or anything older than 10 minutes is
   * dropped, and every file is removed.
   */
  private replaySpool(): void {
    const dir = join(paths.runDir(), "spool");
    let names: string[];
    try {
      names = readdirSync(dir)
        .filter((n) => n.endsWith(".frame"))
        .sort();
    } catch {
      return;
    }
    const now = Date.now();
    for (const n of names) {
      const file = join(dir, n);
      try {
        const at = Number(BigInt(n.split("-")[0]!) / 1_000_000n);
        if (now - at < 10 * 60_000) {
          const f = JSON.parse(readFileSync(file, "utf8")) as {
            type?: string;
            agent?: string;
            event?: string;
            input?: unknown;
          };
          if (f.type === "hook" && f.agent && f.event) replayHook(this.ctx, f.agent, f.event, f.input);
        }
      } catch (e) {
        this.log(`spool: skipped ${n}: ${(e as Error).message}`);
      } finally {
        try {
          unlinkSync(file);
        } catch {}
      }
    }
  }

  private ownsSocket(): boolean {
    try {
      return statSync(this.socketPath).ino === this.socketIno;
    } catch {
      return false;
    }
  }

  private accept(sock: Socket): void {
    this.sockets.add(sock);
    sock.on("close", () => this.sockets.delete(sock));
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (d: string) => {
      buf += d;
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) void this.respond(sock, line);
        nl = buf.indexOf("\n");
      }
    });
    sock.on("error", () => {});
  }

  private async respond(sock: Socket, line: string): Promise<void> {
    this.touch();
    // A frame spooled in the instant between a failed dial and this daemon listening is replayed by the
    // next hook, not left until the next start. One stat per frame.
    if (existsSync(join(paths.runDir(), "spool"))) this.replaySpool();
    this.inflight++;
    try {
      const reply = await this.handleLine(line);
      if (!sock.destroyed) sock.write(`${JSON.stringify(reply)}\n`);
    } finally {
      this.inflight--;
    }
  }

  /** Parse and dispatch one frame. Exposed for in-process tests. */
  async handleLine(line: string): Promise<ReplyFrame> {
    const base = { v: PROTOCOL_VERSION, daemon: SIEVE_VERSION };
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return { ...base, ok: false, error: { code: "bad_request", message: "frame is not valid JSON" } };
    }
    const parsed = RequestFrame.safeParse(json);
    if (!parsed.success) {
      return { ...base, ok: false, error: { code: "bad_request", message: parsed.error.message } };
    }
    const f = parsed.data;
    const id = f.id !== undefined ? { id: f.id } : {};
    if (f.v !== PROTOCOL_VERSION) {
      return {
        ...base,
        ...id,
        ok: false,
        error: {
          code: "version_mismatch",
          message: `daemon speaks protocol ${PROTOCOL_VERSION}, client sent ${f.v}`,
        },
      };
    }
    const q = this.ctx.queue;
    try {
      switch (f.type) {
        case "ping":
          return { ...base, ...id, ok: true, result: { pid: process.pid } };
        case "hook": {
          q.busy.hook++;
          try {
            return {
              ...base,
              ...id,
              ok: true,
              result: handleHook(this.ctx, f.agent ?? "", f.event ?? "", f.input),
            };
          } finally {
            q.busy.hook--;
          }
        }
        case "tool": {
          q.busy.tool++;
          try {
            const result = await callTool(this.ctx, this.jobs, f.tool ?? "", f.args, f.cwd ?? process.cwd());
            return { ...base, ...id, ok: true, result };
          } finally {
            q.busy.tool--;
          }
        }
        case "status":
          return { ...base, ...id, ok: true, result: this.status() };
        case "shutdown":
          setTimeout(() => void this.stop(), 10);
          return { ...base, ...id, ok: true, result: { stopping: true } };
      }
    } catch (e) {
      if (e instanceof ToolError)
        return { ...base, ...id, ok: false, error: { code: e.code, message: e.message } };
      this.log(`error handling ${f.type}: ${(e as Error).stack ?? e}`);
      return { ...base, ...id, ok: false, error: { code: "internal", message: (e as Error).message } };
    }
  }

  status(): StatusReport {
    return {
      daemon: {
        version: SIEVE_VERSION,
        protocol: PROTOCOL_VERSION,
        pid: process.pid,
        uptimeMs: Date.now() - this.startedAt,
        rssBytes: process.memoryUsage().rss,
      },
      queue: {
        hook: this.ctx.queue.busy.hook,
        tool: this.ctx.queue.busy.tool,
        background: this.ctx.queue.depth,
      },
      agents: this.ctx.health.agents(),
      misses: readMisses(paths.misses()),
      projects: this.ctx.global.projectCount(),
      idleShutdownMinutes: this.idleMs / 60_000,
      watchers: this.ctx.watcherStatus(),
      outlines: this.ctx.outliner.ready,
      counters: { ...this.ctx.counters },
    };
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    // Whatever fails below, the process must end. Found: when SIEVE_HOME was deleted during shutdown,
    // the final flush threw, onStop never ran, and the half-stopped daemon spun at 100% CPU for good.
    const deadline = setTimeout(() => {
      // Queued indexing that is cut here is not lost: rows stay `indexed = 0` and sieve_search resumes them.
      this.log(`shutdown took over ${this.shutdownMs} ms; exiting anyway`);
      this.exit();
    }, this.shutdownMs);
    const step = async (name: string, f: () => unknown) => {
      try {
        await f();
      } catch (e) {
        this.log(`shutdown: ${name} failed: ${(e as Error).message}`);
      }
    };
    try {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      if (this.flushTimer) clearInterval(this.flushTimer);
      if (this.notifyTimer) clearInterval(this.notifyTimer);
      await step("jobs", () => this.jobs.killAll());
      // Stop accepting, let replies already being computed go out (up to 2 s), then drop the
      // connections that remain: close() waits for every open one, and a connected MCP proxy
      // never disconnects by itself (measured: close() was still waiting after 3 s).
      await step("server", async () => {
        const closed = new Promise<void>((res) => (this.server ? this.server.close(() => res()) : res()));
        for (let i = 0; i < 100 && this.inflight > 0; i++) await Bun.sleep(20);
        for (const s of this.sockets) s.end();
        await Bun.sleep(10);
        for (const s of this.sockets) s.destroy();
        await closed;
      });
      await step("queue", () => this.ctx.queue.drain());
      await step("databases", () => this.ctx.close());
      // Remove the socket and lock only while they are still ours, never a newer daemon's.
      if (this.ownsSocket()) await step("socket", () => unlinkSync(this.socketPath));
      await step("lock", () => {
        if (readFileSync(this.lockPath, "utf8").trim() === String(process.pid)) unlinkSync(this.lockPath);
      });
      await step("log", () => this.log("stopped"));
    } finally {
      clearTimeout(deadline);
      this.exit();
    }
  }

  private exit(): void {
    if (this.exited) return;
    this.exited = true;
    this.onStop?.();
  }
}
