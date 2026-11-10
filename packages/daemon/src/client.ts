import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, openSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { paths } from "@sieve/core";
import { PROTOCOL_VERSION, type ReplyFrame, type RequestFrame } from "@sieve/protocol";

/** argv that starts the daemon: the compiled binary, or `bun <cli main.ts>` from source. */
export function daemonCommand(): string[] {
  if (process.env.SIEVE_BIN) return [process.env.SIEVE_BIN, "daemon", "run"];
  if (Bun.main.startsWith("/$bunfs") || Bun.main.startsWith("B:\\~BUN"))
    return [process.execPath, "daemon", "run"];
  return [
    process.execPath,
    fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url)),
    "daemon",
    "run",
  ];
}

/** Start the daemon detached; its output goes to the daemon log. */
export function spawnDaemon(): void {
  mkdirSync(paths.logsDir(), { recursive: true, mode: 0o700 });
  mkdirSync(paths.runDir(), { recursive: true, mode: 0o700 });
  appendFileSync(paths.spawns(), `${Date.now()}\n`);
  const log = openSync(paths.daemonLog(), "a");
  const [cmd, ...args] = daemonCommand();
  const child = spawn(cmd!, args, { detached: true, stdio: ["ignore", log, log], env: process.env });
  child.unref();
}

export class DaemonClient {
  private buf = "";
  private seq = 0;
  private waiting = new Map<string, (r: ReplyFrame) => void>();
  private constructor(private readonly sock: Socket) {
    sock.setEncoding("utf8");
    sock.on("data", (d: string) => {
      this.buf += d;
      let nl = this.buf.indexOf("\n");
      while (nl !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        try {
          const r = JSON.parse(line) as ReplyFrame;
          const cb = r.id ? this.waiting.get(r.id) : undefined;
          if (cb && r.id) {
            this.waiting.delete(r.id);
            cb(r);
          }
        } catch {}
        nl = this.buf.indexOf("\n");
      }
    });
    const failAll = () => {
      for (const [id, cb] of this.waiting) {
        cb({
          v: PROTOCOL_VERSION,
          id,
          ok: false,
          daemon: "?",
          error: { code: "internal", message: "connection closed" },
        });
      }
      this.waiting.clear();
    };
    sock.on("close", failAll);
    sock.on("error", failAll);
  }

  static tryConnect(socketPath = paths.socket(), timeoutMs = 500): Promise<DaemonClient | null> {
    return new Promise((resolve) => {
      const sock = connect(socketPath);
      const t = setTimeout(() => {
        sock.destroy();
        resolve(null);
      }, timeoutMs);
      sock.once("connect", () => {
        clearTimeout(t);
        resolve(new DaemonClient(sock));
      });
      sock.once("error", () => {
        clearTimeout(t);
        resolve(null);
      });
    });
  }

  /** Connect, starting the daemon if needed and waiting up to `waitMs` for it. */
  static async connect(opts: { autostart?: boolean; waitMs?: number } = {}): Promise<DaemonClient | null> {
    const first = await DaemonClient.tryConnect();
    if (first || !opts.autostart) return first;
    spawnDaemon();
    const deadline = Date.now() + (opts.waitMs ?? 3000);
    while (Date.now() < deadline) {
      await Bun.sleep(25);
      const c = await DaemonClient.tryConnect();
      if (c) return c;
    }
    return null;
  }

  request(frame: Omit<RequestFrame, "v" | "id">, timeoutMs = 30_000): Promise<ReplyFrame> {
    const id = `c${++this.seq}`;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiting.delete(id);
        resolve({
          v: PROTOCOL_VERSION,
          id,
          ok: false,
          daemon: "?",
          error: { code: "internal", message: "timed out" },
        });
      }, timeoutMs);
      this.waiting.set(id, (r) => {
        clearTimeout(t);
        resolve(r);
      });
      this.sock.write(`${JSON.stringify({ v: PROTOCOL_VERSION, id, ...frame })}\n`);
    });
  }

  close(): void {
    this.sock.end();
  }
}
