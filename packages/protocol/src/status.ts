export interface LatencySummary {
  count: number;
  p50: number;
  p99: number;
}

export interface AgentStatus {
  agent: string;
  lastHookAt: number | null;
  events: Array<{ event: string; lastAt: number; count: number }>;
  latencyMs: LatencySummary;
}

export interface StatusReport {
  daemon: { version: string; protocol: number; pid: number; uptimeMs: number; rssBytes: number };
  queue: { hook: number; tool: number; background: number };
  agents: AgentStatus[];
  misses: { total: number; last24h: number; lastAt: number | null; lastReason: string | null };
  projects: number;
  idleShutdownMinutes: number;
}
