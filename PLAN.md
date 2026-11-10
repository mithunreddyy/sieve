# Sieve build plan

Source of truth for scope: [prompt.md](prompt.md) Part 3. Design: [DESIGN.md](DESIGN.md). Decisions: [docs/adr/](docs/adr/).

Each slice is a vertical slice: it ships working and tested before the next starts. Status: ✅ done · 🟡 partial · ⬜ not started.

## Open items before a public release
- **Name.** `sieve` is taken on npm (v0.0.4, unrelated). GitHub org, Homebrew formula, and domain are unchecked. Decide before the first publish; the code uses the name in the binary, socket path, and `~/.sieve`.
- **Go module path** `github.com/sieve-dev/sieve/shim` is a placeholder.
- **Real-agent verification.** Slice 1 is tested against Claude Code's hook JSON as documented and as read from Claude Code 2.1.319, not yet by a live Claude Code session in CI.

## Slice 1: Runtime skeleton ✅ (2026-11-10)

| Item | Status | Where / notes |
|---|---|---|
| Daemon: start on demand, idle shutdown, version handshake, `sieve status` | ✅ | `packages/daemon/src/server.ts`. Single instance via O_EXCL lock with stale-pid takeover. Protocol version checked on every frame. |
| Go hook shim that fails open | ✅ | `shim/`. 2.3 MB static, ~2 ms warm end to end. Daemon down / hung / bad reply all pass through and log a miss. Crash-loop cap (5 spawns / 60 s → 5 min pause). |
| MCP stdio proxy | ✅ | `packages/mcp`. Stateless; strict JSON schemas generated from zod; reconnects once if the daemon restarted. |
| SQLite storage with archive IDs | ✅ | `packages/core/src/store.ts`. Content-addressed `s_…` ids, gzip blobs, porter + trigram FTS5, sightings per session/worktree. |
| `sieve_run` (no isolation) with receipts | ✅ | `packages/daemon/src/jobs.ts`. Process-group kill on timeout, background handles via `sieve_get j_…`, JS/TS on Sieve's own Bun. States `isolation: none`. |
| `sieve_get`, `sieve_search` | ✅ | 100 KB pages with a continuation line; RRF k=60 + 14-day recency + session boost, 5 per page, cursor, timeline sort, scopes. |
| Claude Code adapter + setup with backup and rollback | ✅ | `packages/adapters/claude-code`. Replaces any tool's output via `updatedToolOutput`. Idempotent; rollback on failed check; `--remove` per ADR 0004. |
| Benchmark harness: 5 tasks + latency micro-benchmarks | 🟡 | `packages/bench`. Offline replay of 5 **synthetic** tasks + end-to-end hook latency. The paired real-agent runner (task success, CIs, cost) is not built. Results: [docs/bench/slice-1.md](docs/bench/slice-1.md). |
| Also shipped | ✅ | `sieve_index` (path via `git ls-files`, or content), `sieve_stats`, `sieve doctor` (versions, daemon, hooks fired, config, DB integrity, MCP handshake + schema token cost, isolation), TS hook fallback `sieve hook`. |

**Deviations from prompt.md, with reasons**
- Claude Code is a *replace* agent, not route-only: Claude Code 2.1.319 accepts `hookSpecificOutput.updatedToolOutput` for every tool (DESIGN §3).
- File reads (`Read`) and edits are archived but never folded in slice 1; smart reads with outlines arrive in slice 3, and folding a file the agent is about to edit would hurt it.
- The fallback fold lifts error/failure lines out of the dropped middle. Found by the replay benchmark: without it, one failing test among 420 passing ones disappeared from view.
- `sieve setup --remove` strips entries instead of restoring backups (ADR 0004).
- Search spelling correction was deferred from slice 1 and built in slice 2.
- Fold counters in `sieve_stats` are in-memory since daemon start; persisted per-session stats come with the dashboard (slice 9).

**Known gaps carried forward**
- Windows: the shim cross-compiles, but the daemon listens on a Unix socket; named-pipe support and a Windows CI run are needed before Windows is claimed.
- CI is written (`.github/workflows/ci.yml`) but has **not run yet**: it needs the repo pushed to GitHub. Jobs: lint, typecheck, Go tests and all tests on Linux; the full test suite on macOS; a networking-off test run (Linux network namespace); the replay gate on real output; and a Windows shim build. There is no Windows test job: the daemon listens on a Unix socket and has no named-pipe transport yet (see below).
- `sieve upgrade`'s drain-and-restart on binary change is designed (DESIGN §2) but not built.
- Retention (30 days unread, 500 MB cap, 14-day project cleanup) is designed, not built.

## Slice 2: Extractors v1 ✅ (2026-11-10)

| Item | Status | Where / notes |
|---|---|---|
| Extractor framework | ✅ | `packages/core/src/extract/`. Interface and selection rules: DESIGN §6. Wired into the hook path and `sieve_run`. |
| Test runners: jest, vitest, pytest, go test, cargo test, rspec, JUnit XML, playwright (+ bun test) | ✅ | cargo test, rspec and playwright are tested on **hand-written** fixtures only (tools not installed on the capture machine). |
| Compilers/linters: tsc, eslint, biome, rustc/cargo/clippy, gcc/clang, mypy, ruff | ✅ | One grouping engine: every location kept, identifiers that differ listed per location. rustc tested on a hand-written fixture only. |
| Package managers, git (diff/log/status), JSON, logs (Drain), HTML → Markdown | ✅ | |
| Search-results extractor | ✅ | Fixes the slice-1 `refactor-across-files` loss (definitions surface first, quoted verbatim). |
| Snapshot tests from real captured output | ✅ | 31 captured + 4 hand-written fixtures, each with provenance (`captured.tsv`: command + tool version), must-keep facts, and a snapshot. `capture.sh` regenerates them. |
| Replay benchmark on real output | ✅ | All 35 fixtures through the hook-path fold: 81% fewer tokens, 0 facts lost. [docs/bench/slice-2.md](docs/bench/slice-2.md). |
| Spelling fix in search | ✅ | Contentless word index + `fts5vocab`; ≤ 1 edit for words up to 5 letters, ≤ 2 otherwise, same first letter. The tool output says what it searched for instead. |
| `sieve_batch` | ✅ | Runs commands in order, indexes each output, answers each query from those outputs only (top 3). |

**Deviations and decisions**
- `Extractor.extract` may return `null` (did not parse after all); the next candidate runs. `dropped` is a list, not a string. `ExtractInput` gained `pattern` and `budget` (DESIGN §6).
- Failures are never cut, but a body with failures may not grow without bound: past 3× the budget it is cut at a whole line and every error line after the cut is still listed (up to 60). Every byte remains in the archive.
- Compiler/linter duplicates keep one full code frame per group, not one per location; every location (up to 200 per group) is listed with its varying identifiers.
- HTML keeps the page's main content and a heading outline; the archive holds the raw HTML, so `sieve_get` line ranges refer to the HTML, not the Markdown.
- Outputs under 4 KB still pass through unfolded (the replace threshold), even when an extractor would shorten them.
- The Claude Code adapter now refuses to rewrite any tool-response shape it does not know (found while adding Grep support); such outputs are archived and passed through.

**Known gaps carried forward**
- No captured fixtures yet for cargo, rspec, playwright, gcc (clang only), yarn, poetry; no Windows-specific output.
- Diff-aware reruns ("2 now pass, 1 new failure") are slice 3, with the watchers.

## Slice 3: Watchers, smart reads, staleness ✅ (2026-11-10)

| Item | Status | Where / notes |
|---|---|---|
| Project watcher with incremental tree-sitter outlines | ✅ | `daemon/src/watcher.ts`, `core/src/outline/`. Bun `fs.watch` (recursive) + `git ls-files` for the initial set; 12 languages + Markdown; parsing in a worker thread (ADR 0005). |
| Git watcher | ✅ | Watches HEAD, index, refs via the git dir; records reflog messages; rechecks every known file after a checkout/reset. Attribution uses when the daemon saw the operation (the reflog has whole seconds only). |
| Smart reads (`sieve_read`, and Claude Code `Read`) | ✅ | Outline + intent lines for files over 16 KB; "unchanged since read #N"; only the changed hunks. Claude Code reads are declined once in `PreToolUse` (ADR 0006); `reads.smart = false` turns it off. |
| Diff-aware rereads and reruns | ✅ | Identical rerun → one line; tests/diagnostics → fixed / new / still failing (extractor `keys`); other small changes → only the changed lines. Per session + agent context + epoch. |
| Staleness flags | ✅ | Next prompt names files changed on disk since they were read (with the git operation, if any), once per change; search hits from changed files are flagged. |
| Symbol search | ✅ | `sieve_search` lists matching symbols (exact names first) above archived hits. |
| Config file | ✅ | `~/.sieve/config.toml` (DESIGN §6a). |
| Benchmarks | ✅ | Smart-read and Read-hook latency added. [docs/bench/slice-3.md](docs/bench/slice-3.md). |

**Deviations and decisions**
- `@parcel/watcher` replaced by Bun's recursive `fs.watch`; `web-tree-sitter` + separate grammars replaced by `@vscode/tree-sitter-wasm` (ADR 0005, with measurements).
- Reads are steered before they run, not rewritten after (ADR 0006). This is the only place Sieve declines a tool call before Guard (slice 7) and steering (slice 9).
- Reruns and smart reads depend on what the same reader saw before; ADR 0003 has an addendum.
- The "reads" table in the original design (one `stale` flag per row) became `files` + `reads` + `runs`: staleness is computed by comparing content ids, so nothing has to be flagged eagerly.
- Found only by using it live in a Claude Code session, after the slice was declared done: prompts were matched with their harness boilerplate and stopwords, and object-valued top-level consts were missing from outlines (both fixed, with tests; see the bench report).
- Fixed along the way: `sieve_search` never said when it corrected a spelling (a slice-2 edit that silently did not apply; now tested); `outlinesReady()` was true after the first grammar loaded; queued background work could run after the databases closed; symlinked paths (macOS `/tmp`) broke relative paths and read history.

**Known gaps carried forward**
- Recursive watching on Linux and Windows is not verified (no CI there yet).
- Files over 2 MB are never smart-read on a hook (they pass through); files over 10 MB are never read by Sieve.
- Memory facts tied to changed files (prompt.md §2 git watcher) wait for memory in slice 8.

## Slice 4: Session log, state block, recall, decisions ⬜
`session_log`, background state-block precompute after `turn.end`, `sieve_resume`, recall pointers on `prompt.submit` (≤ 3, ≤ 2 KB), decisions with supersession.

## Slice 5: Adapters ⬜
Codex, Gemini CLI, Copilot CLI, Cursor, OpenCode (in-process). Event-gap filling. CI-verified support matrix; unverified adapters labelled "preview".

## Slice 6: Sandbox isolation + secret masking ⬜
Seatbelt (macOS), bwrap / Landlock+seccomp helper (Linux), AppContainer + Job Object helper (Windows). Env allowlist, per-call grants, isolation reporting. Secret masking before storage.

## Slice 7: Guard ⬜
Command parser through wrappers, behaviour checks in the sandbox, rule grammar (DESIGN §7), presets, ask/monitor modes, `sieve guard test`, hash-chained audit log.

## Slice 8: Memory + skills ⬜
Facts with two timelines, trust levels, slot-drift resolution, Markdown sync, `sieve_remember` / `sieve_recall`, skills import and matching.

## Slice 9: Steering, TUI, dashboard ⬜
## Slice 10: Local proxy ⬜
## Slice 11: Session export/import, encrypted sync, login service, upgrade ⬜
## Slice 12: Remaining adapters, local embeddings + reranker, public paired benchmark, v1.0 ⬜
