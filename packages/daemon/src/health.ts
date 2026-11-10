import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type { GlobalStore } from "@sieve/core";
import type { AgentStatus, LatencySummary } from "@sieve/protocol";

const RING = 2048;

class Ring {
  private buf = new Float64Array(RING);
  private n = 0;
  push(v: number) {
    this.buf[this.n++ % RING] = v;
  }
  summary(): LatencySummary {
    const count = Math.min(this.n, RING);
    if (count === 0) return { count: this.n, p50: 0, p99: 0 };
    const s = Array.from(this.buf.subarray(0, count)).sort((a, b) => a - b);
    const at = (q: number) => s[Math.min(count - 1, Math.floor(q * count))]!;
    return { count: this.n, p50: round(at(0.5)), p99: round(at(0.99)) };
  }
}
const round = (x: number) => Math.round(x * 100) / 100;

/**
 * Per-agent heartbeats and latency. Heartbeats are kept in memory and flushed to the
 * global database in the background, so recording one never touches disk on the hook path.
 */
export class Health {
  private latency = new Map<string, Ring>();
  private pending = new Map<string, { agent: string; event: string; lastAt: number; n: number }>();

  constructor(private readonly global: GlobalStore) {}

  record(agent: string, event: string, at: number, ms: number): void {
    const key = `${agent}\u0000${event}`;
    const p = this.pending.get(key);
    if (p) {
      p.lastAt = Math.max(p.lastAt, at);
      p.n++;
    } else this.pending.set(key, { agent, event, lastAt: at, n: 1 });
    let r = this.latency.get(agent);
    if (!r) {
      r = new Ring();
      this.latency.set(agent, r);
    }
    r.push(ms);
  }

  flush(): void {
    if (this.pending.size === 0) return;
    const rows = [...this.pending.values()];
    this.pending.clear();
    this.global.db.transaction(() => {
      for (const r of rows) this.global.recordHook(r.agent, r.event, r.lastAt, r.n);
    })();
  }

  agents(): AgentStatus[] {
    this.flush();
    const by = new Map<string, AgentStatus>();
    for (const row of this.global.health()) {
      let a = by.get(row.agent);
      if (!a) {
        a = { agent: row.agent, lastHookAt: null, events: [], latencyMs: { count: 0, p50: 0, p99: 0 } };
        by.set(row.agent, a);
      }
      a.events.push({ event: row.event, lastAt: row.lastAt, count: row.count });
      a.lastHookAt = Math.max(a.lastHookAt ?? 0, row.lastAt);
    }
    for (const [agent, ring] of this.latency) {
      const a = by.get(agent);
      if (a) a.latencyMs = ring.summary();
    }
    return [...by.values()];
  }
}

export interface MissSummary {
  total: number;
  last24h: number;
  lastAt: number | null;
  lastReason: string | null;
}

/** Misses are written by the shim (one line each: ms, agent, event, reason). Read the tail only. */
export function readMisses(file: string, now = Date.now()): MissSummary {
  const empty = { total: 0, last24h: 0, lastAt: null, lastReason: null };
  if (!existsSync(file)) return empty;
  const size = statSync(file).size;
  const len = Math.min(size, 1 << 20);
  const fd = openSync(file, "r");
  const buf = Buffer.alloc(len);
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n").filter(Boolean);
  if (len < size) lines.shift();
  let last24h = 0;
  let lastAt: number | null = null;
  let lastReason: string | null = null;
  for (const l of lines) {
    const [ms, , , reason] = l.split("\t");
    const t = Number(ms);
    if (!Number.isFinite(t)) continue;
    if (now - t < 86_400_000) last24h++;
    if (lastAt === null || t >= lastAt) {
      lastAt = t;
      lastReason = reason ?? null;
    }
  }
  return { total: lines.length, last24h, lastAt, lastReason };
}
