import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
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
import { handleHook } from "./pipeline.ts";
import { callTool, ToolError } from "./tools.ts";

export interface DaemonOptions {
  socketPath?: string;
  lockPath?: string;
  /** Minutes without requests before exiting; 0 = never. */
  idleMinutes?: number;
  /** Interval of the maintenance tick (health flush; WAL checkpoint every second tick). Default 5000. */
  maintenanceMs?: number;
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
  private readonly startedAt = Date.now();
  private readonly socketPath: string;
  private readonly lockPath: string;
  private readonly idleMs: number;
  private readonly maintenanceMs: number;
  private stopping = false;
  private log: (msg: string) => void;
  onStop: (() => void) | null = null;

  constructor(opts: DaemonOptions = {}) {
    this.socketPath = opts.socketPath ?? paths.socket();
    this.lockPath = opts.lockPath ?? paths.lock();
    const idle = opts.idleMinutes ?? Number(process.env.SIEVE_IDLE_MINUTES ?? 30);
    this.idleMs = Number.isFinite(idle) && idle > 0 ? idle * 60_000 : 0;
    this.maintenanceMs = opts.maintenanceMs ?? 5000;
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
    this.flushTimer = setInterval(() => {
      this.ctx.queue.add("flush-health", () => this.ctx.health.flush());
      // Auto-checkpoint is off in the daemon (see OpenOptions.manualCheckpoint); do it here, every 10 s.
      ticks++;
      this.ctx.closeIdleWatchers();
      if (ticks % 2 === 0) this.ctx.queue.add("checkpoint", () => this.ctx.checkpointAll());
    }, this.maintenanceMs);
    this.flushTimer.unref?.();
    this.touch();
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

  private accept(sock: Socket): void {
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
    const reply = await this.handleLine(line);
    if (!sock.destroyed) sock.write(`${JSON.stringify(reply)}\n`);
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
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.jobs.killAll();
    await new Promise<void>((res) => (this.server ? this.server.close(() => res()) : res()));
    await this.ctx.queue.drain();
    this.ctx.close();
    for (const f of [this.socketPath, this.lockPath]) {
      try {
        unlinkSync(f);
      } catch {}
    }
    this.log("stopped");
    this.onStop?.();
  }
}
