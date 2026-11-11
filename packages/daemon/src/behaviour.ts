import { type ChildProcess, spawn } from "node:child_process";
import type { Observed } from "@sieve/guard";

/**
 * Watches what sandboxed runs do (slice 7, macOS). The kernel writes a line to the system log
 * for every operation a Seatbelt clause asks it to report, and for every operation it refuses:
 *
 *   Sandbox: cat(36917) deny(1) file-read-data /private/tmp/x/denied/f
 *   Sandbox: curl(36918) allow network-outbound remote:*:9
 *
 * One long-lived `log stream` reads them (no per-run start-up cost after the first), and a run
 * is handed the lines that belong to its process group. Limits, stated plainly:
 *  - attribution uses the pids seen in the run's process group, sampled while it runs, plus the
 *    pids the sandbox reported starting a program; a process that lives less than the sampling
 *    interval and starts no program can be missed;
 *  - the sandbox reports loopback and wildcard network targets as "*": only the port is known;
 *  - the system log can drop lines under extreme load.
 */

const LINE = /Sandbox: (.+?)\((\d+)\) (allow|deny\(\d+\)) (\S+)(?: (.*))?$/;

export function parseSandboxLine(line: string): Observed | null {
  const m = LINE.exec(line);
  if (!m) return null;
  return {
    proc: m[1]!,
    pid: Number(m[2]),
    verdict: m[3]!.startsWith("deny") ? "deny" : "allow",
    op: m[4]!,
    target: (m[5] ?? "").trim(),
  };
}

interface Stamped extends Observed {
  t: number;
  seq: number;
}

const FLUSH_MS = 200;
const SETTLE_MS = 80;
const WARM_MS = 400;
const KEEP_EVENTS = 20_000;
const IDLE_STOP_MS = 120_000;

export interface Recording {
  /** Stop sampling, wait for the log to flush, and return what this run did. */
  finish(): Promise<Observed[]>;
}

export class BehaviourWatcher {
  private stream: ChildProcess | null = null;
  private events: Stamped[] = [];
  /** Runs being recorded now; `overlapped` is set once two have ever been recorded at the same time. */
  private runs = new Set<{ overlapped: boolean }>();
  /** A marker report has been seen on the current stream: it is attached to the kernel log. */
  private attached = false;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private buf = "";
  private seq = 0;
  private warmed = false;
  private markers = new Set<number>();

  /** Only macOS has a sandbox that reports to a log we can read. */
  static available(): boolean {
    return process.platform === "darwin";
  }

  /**
   * Make sure the stream is running AND attached. A fresh `log stream` takes a variable moment
   * to attach to the kernel log, and a report logged before that is lost for good, so a fixed
   * delay would sometimes miss a run's first reports. Markers are sent until one is seen.
   */
  async ready(): Promise<boolean> {
    if (!BehaviourWatcher.available()) return false;
    if (!this.stream || this.stream.exitCode !== null) {
      this.start();
      this.attached = false;
      this.warmed = false;
    }
    if (!this.attached) {
      for (let i = 0; i < 12 && !this.attached; i++) {
        if (!this.stream) return false;
        this.attached = (await this.barrier(700)) !== null;
      }
    }
    if (this.attached && !this.warmed) {
      // Right after attaching, the stream has been seen to lose reports from processes that exec
      // twice (Python); a few more markers and a short pause let it settle.
      this.warmed = true;
      for (let i = 0; i < 3; i++) await this.barrier(700);
      await new Promise((r) => setTimeout(r, WARM_MS));
    }
    return this.stream !== null && this.attached;
  }

  private start(): void {
    this.buf = "";
    try {
      // `log stream` block-buffers when it writes to a pipe, so a lone sandbox line can sit for
      // seconds until system noise fills the buffer. Running it under `script` gives it a
      // terminal, which makes it line-buffered: a report reaches us within milliseconds.
      // `script` needs a real pipe on its stdin (a socket pair makes it quit), so a shell makes
      // one; the group is killed as a whole on stop, and the terminal closing ends `log`.
      // The group is detached, so it would outlive an owner that dies without stop() (a crash,
      // kill -9, a test process exiting): found as orphaned `log stream`s, one per test run. A
      // watchdog in the same group checks the owner every 2 s and then ends the whole group.
      const cmd =
        `(while kill -0 ${process.pid} 2>/dev/null; do sleep 2; done; kill -TERM 0) & ` +
        "sleep 2147483647 | exec /usr/bin/script -q /dev/null /usr/bin/log stream --style compact --level default " +
        '--predicate \'process == "kernel" AND eventMessage CONTAINS "Sandbox:"\'';
      const p = spawn("/bin/sh", ["-c", cmd], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
      p.on("error", () => {
        this.stream = null;
      });
      p.on("exit", () => {
        if (this.stream === p) {
          this.stream = null;
          this.attached = false;
        }
      });
      p.stdout?.on("data", (d: Buffer) => this.onData(d));
      // The stream must never keep the daemon alive or block its exit.
      p.unref();
      (p.stdout as unknown as { unref?: () => void } | null)?.unref?.();
      this.stream = p;
    } catch {
      this.stream = null;
    }
  }

  private onData(d: Buffer): void {
    this.buf += d.toString("utf8");
    for (let nl = this.buf.indexOf("\n"); nl !== -1; nl = this.buf.indexOf("\n")) {
      // A terminal ends lines with CR LF.
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      const o = parseSandboxLine(line);
      if (o) {
        this.events.push({ ...o, t: Date.now(), seq: ++this.seq });
        if (this.events.length > KEEP_EVENTS) this.events.splice(0, this.events.length - KEEP_EVENTS / 2);
      }
    }
  }

  /**
   * Wait until the stream has caught up with everything logged so far. The log delivers some
   * programs' reports (Homebrew Python, Bun) seconds late, so no fixed delay is right. Instead a
   * trivial sandboxed process is started whose report has a pid we know; the log is in order,
   * so once that report arrives, every earlier one has. Returns the marker's pid so the caller
   * can leave its report out, or null if the marker never showed (the wait is capped).
   */
  private async barrier(capMs = 3000): Promise<number | null> {
    const profile =
      '(version 1)(allow default)(allow file-read* (literal "/private/etc/hosts") (with report))';
    let pid: number | null = null;
    try {
      const m = spawn("/usr/bin/sandbox-exec", ["-p", profile, "/bin/cat", "/etc/hosts"], {
        stdio: "ignore",
      });
      m.on("error", () => {});
      pid = m.pid ?? null;
    } catch {
      return null;
    }
    if (pid === null) return null;
    this.markers.add(pid);
    const deadline = Date.now() + capMs;
    while (Date.now() < deadline) {
      if (this.events.some((e) => e.pid === pid && e.op.startsWith("file-read"))) return pid;
      await new Promise((r) => setTimeout(r, 15));
    }
    return null;
  }

  /** Where the log is now: take it just before starting a run, and hand it to `begin`. */
  position(): number {
    return this.seq;
  }

  /** Begin recording a run whose processes all belong to the process group `pgid`. */
  begin(pgid: number, since?: number): Recording {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    // A run that ever overlapped another cannot tell, from timing alone, which reports are its own.
    const me = { overlapped: this.runs.size > 0 };
    for (const r of this.runs) r.overlapped = true;
    this.runs.add(me);
    const start = Date.now();
    // The previous run's barrier delivered everything logged before now, so nothing at or below
    // this sequence number can belong to this run.
    const startSeq = since ?? this.seq;
    const pids = new Set<number>([pgid]);
    let stopped = false;
    const sample = () => {
      if (stopped) return;
      const ps = spawn("/bin/ps", ["-A", "-o", "pid=,pgid="], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      ps.stdout?.on("data", (d: Buffer) => {
        out += d.toString();
      });
      ps.on("error", () => {});
      ps.on("close", () => {
        for (const l of out.split("\n")) {
          const [p, g] = l.trim().split(/\s+/).map(Number);
          if (p && g === pgid) pids.add(p);
        }
        // Dense at first, when most short-lived children start; sparse for long runs.
        if (!stopped) setTimeout(sample, Date.now() - start > 2000 ? 250 : 40).unref?.();
      });
    };
    sample();
    return {
      finish: async () => {
        stopped = true;
        const marker = await this.barrier();
        // Without the marker the stream may be behind: give it a moment, as best effort.
        // The log is not strictly ordered across processes: a report can land just after the
        // marker's. A short settle after the marker catches those; without a marker, wait longer.
        await new Promise((r) => setTimeout(r, marker === null ? FLUSH_MS : SETTLE_MS));
        this.runs.delete(me);
        if (this.runs.size === 0)
          this.idle = setTimeout(() => this.stop(), IDLE_STOP_MS).unref?.() as unknown as ReturnType<
            typeof setTimeout
          >;
        const mine = this.events.filter((e) => e.seq > startSeq && !this.markers.has(e.pid));
        const out = me.overlapped
          ? // Several runs at once: only the processes seen in this run's group.
            mine.filter((e) => pids.has(e.pid))
          : // Alone: every report is this run's (only profiles that ask for reports produce
            // them). A refusal is kept too, even from a pid never sampled: a program that forks
            // a child which immediately tries a refused exec lives only milliseconds. Another
            // app's sandbox refusing something could be listed here; it only becomes a note if a
            // rule matches it.
            (() => {
              // Other apps' sandboxes log here too. Processes this run starts get pids just above
              // the ones seen, so reports from pids far outside that range are not this run's.
              const seen = [...pids, ...mine.filter((e) => /^process-exec/.test(e.op)).map((e) => e.pid)];
              const lo = Math.min(...seen);
              const hi = Math.max(...seen) + 300;
              return mine.filter((e) => e.pid >= lo && e.pid <= hi);
            })();
        if (marker !== null) this.markers.delete(marker);
        return out.map(({ t: _t, seq: _s, ...o }) => o);
      },
    };
  }

  /** The stream's process group id, while one runs. */
  get streamPid(): number | null {
    return this.stream?.pid ?? null;
  }

  stop(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    try {
      if (this.stream?.pid) process.kill(-this.stream.pid, "SIGTERM");
    } catch {}
    this.stream = null;
  }
}
