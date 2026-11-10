# ADR 0002: Start the daemon on demand, fail open, optional login service

**Status:** accepted · 2026-11-10

## Decision

- The first shim or MCP-proxy call that finds no daemon starts `sieve daemon run` detached (new session, stdio to `~/.sieve/logs/sieved.log`) and **passes its own call through raw**. It does not wait.
- The MCP proxy is the exception: it is long-lived and has no per-call budget, so it waits up to 2 s for the socket after starting the daemon.
- Single instance via an `O_EXCL` lock file holding the pid; a lock whose pid is dead is stale.
- Idle shutdown after `daemon.idle_minutes` (default 30, `0` = never).
- Crash-loop cap: the shim keeps spawn timestamps in `run/spawns`; after 5 spawns in 60 s it stops spawning for 5 minutes and only passes through.
- `sieve service install` (slice 11) adds start-at-login via launchd / systemd user unit / Task Scheduler.

## Options

1. **Always-on service required at install.** Simplest runtime, but install needs OS-specific service setup and fails in containers and CI.
2. **No daemon** (fresh process per hook). No warm state, no watchers; this is the gap Sieve exists to close.
3. **On demand, fail open** (chosen). Works everywhere with zero setup; first call after boot is unfolded.
4. **On demand, shim waits for start-up.** Every cold start would blow the 30 ms p99 budget.

## Reason

Never block the agent (principle 1). Losing the fold on one call after a cold start costs some tokens; blocking a hook costs the user's flow. The login service is there for people who want the first call folded too.

## Consequences

- `sieve status` must make cold-start misses visible so they are not mistaken for broken hooks.
- Tests include fault injection: daemon killed mid-call, daemon hung (socket accepts, never replies), socket file present but stale.
