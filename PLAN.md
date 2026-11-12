# Sieve build plan

Source of truth for scope: [prompt.md](prompt.md) Part 3. Design: [DESIGN.md](DESIGN.md). Decisions: [docs/adr/](docs/adr/).

Each slice is a vertical slice: it ships working and tested before the next starts. Status: ✅ done · 🟡 partial · ⬜ not started.

## Open items before a public release
- **First Linux CI run (2026-11-12): two failures, both fixed, neither yet re-run on Linux.** (1) **A real isolation bug**: the bubblewrap sandbox did not deny a folder inside the project (a later `--bind` shadowed the earlier `--tmpfs`); denies are now mounted last, with tests that fail on the old order. (2) A tokenizer test timed out on the slower runner (its exact-count reference is quadratic); smaller inputs, still past the 256-character giant threshold. The `offline` job (suite in an empty network namespace) had never run and would have failed for every test that hosts a local server, because a new namespace leaves loopback down; it now brings `lo` up (no route out; the next step proves it) and was checked by running the whole suite under a no-network sandbox here (978 pass; the 7 failures all start a local server). Also seen and left: a background indexing task occasionally finishes after a test has closed its daemon's database ("Cannot use a closed database", logged, not failing).
- **Algorithm round 3 (2026-11-12; ADRs 0024, 0025).** Benchmark hardened: neutral environment (the user's other plugins off for runs only; they had added 6–13K tokens to every run), five runs per task per arm, every tool call recorded, dev and held-out sets, held-out written first and run once. Found and fixed: a cold daemon lost the session's first prompt (the shim now spools what it cannot deliver; the daemon replays it; transcript fallback); the agent re-checked the matching-lines note by re-running (note made checkable and explicit); repetitive output in no known format fell back to head and tail (new `repeats` extractor: template folding with rare lines kept verbatim). **Dev: cost −33%, context −17%, 30/30. Held-out: cost −7%, context −6%, 20/20 (Sonnet subset −8%).** The held-out figure is the honest one. Context Mode was not run (the user's choice: they have their own `~/.context-mode` data), so there is no head-to-head result.
- **Is Sieve reducing tokens? (2026-11-12, ADR 0022).** Measured against what Claude Code itself shows, not the raw output. (1) **WebFetch was never shortened**: its result shape `{bytes, code, codeText, durationMs, result, url}` was unknown to the adapter, so no receipt could be written back, yet a fold was counted: the project's "95% fewer" all-time figure was almost entirely these phantom WebFetch folds. Fixed (the receipt goes into `result`), and a fold is now counted only when the adapter can write it back. Not yet seen live. (2) The replay benchmark now uses Claude Code's behaviour as its baseline (output over 30,000 bytes is a 2 KB preview either way): **53% fewer tokens than Claude Code alone on 35 real outputs (was reported as 81% against the raw output)**, no fact lost that Claude Code alone would have shown. It found a JSON receipt with an empty body (the first line was over budget); fixed. (3) Sieve's own overhead is now recorded (`injections` table) and `sieve stats` reports a net figure. (4) Overhead cut: no state block after a canceled `/compact`; open errors only while recent (at most 5); no recall pointers to older versions of files that changed. Claude Code defers MCP tool schemas behind its tool search, so their size is not paid up front.
- **Paired live runs (2026-11-12, 8 pairs, Haiku; ADR 0022):** cost −9%, uncached input −21%, all input including cache reads +44% (25 turns against 16), 8/8 correct in both arms. Sieve did not help on a needle-in-a-list JSON task (+20% cost: the receipt dropped the record, and two extra turns fetched it). WebFetch receipts seen live after the fix (11,021 → 2,069 tokens for one page). Too few pairs for a percentage claim. Next lever: prompt-aware receipts, which would need invariant 3 changed (owner's call).
- **Lines matching the request (ADR 0023, 2026-11-12):** the receipt stays pure; a capped note (rare words of the last prompt, numbers kept, ±2 lines) rides next to it as PostToolUse `additionalContext` (both seen honoured live). Second paired run (12 pairs, two held-out tasks): cost −14%, uncached input −25%, 12/12 correct in both arms, every task at least 10% lower, the JSON task fixed (−28%, from +4%). Turns still higher (31 against 24). Guard's `env-files` ask blocks headless runs that read a `.env` file, by design.
- **First live Claude Code run (2026-11-11).** A headless session (`claude -p`, Claude Code 2.1.319, Haiku) with the plugin loaded by `--plugin-dir` and the user's `sieve setup` hooks: the plugin loaded, its MCP server connected, tools were named `mcp__plugin_sieve_sieve__*`, exactly one of the two hook routes acted, and `sieve_get` through the plugin returned exact lines. **Not shown live: the plugin acting alone** (an isolated config cannot log in without extracting credentials, and CLAUDE.md forbids experiments on the real `~/.claude`), and `sieve_get` going unfolded (that result was 122 characters). It found what replayed tests could not (ADR 0020): Claude Code cuts Bash output at ~30 KB before hooks and shows the model a 2 KB preview, with or without Sieve. Sieve archived only the prefix while saying "Full output archived", never saw an error at line 1,400, and its savings figures compared against the full output. Fixed: the whole result is read from Claude Code's own file (validated, ≤ 256 KiB), the receipt fits the 2 KB window and says what it is, savings are counted against the preview, and the p99 gate is 15 ms for 60 KB. **For results over ~30 KB, Sieve saves no tokens in Claude Code**: its value there is the complete archive, search, exact expansion and errors from the whole output. The 4–30 KB range is unchanged and is where fewer tokens are real.
- **Removing data (ADR 0018):** `sieve purge` (dry run by default), opt-in retention (`[archive] retention_days`, off), tombstones so `sieve_get` says what happened to a removed id. Built and tested; retention has not run on a long-lived project. The message that claimed a 30-day expiry (there was none) is gone.
- **All-time stats:** `sieve stats` adds a line from the `folds` table, so it survives daemon restarts.
- **Indexing a web page (ADR 0019):** `sieve_index { url }`, off unless `[fetch] enabled`, with a strict policy (public addresses only, connect to the checked address, every redirect re-checked). Tested with injected transports and a local TLS server; no real site fetched in tests.
- **Found and fixed while checking the above (ADR 0018, 0019, 0020, 0021):** a purge could be raced by the next hook (now holds the daemon lock, and resets the shim's spawn cap); a session purge tripped `decisions.superseded_by`; `VACUUM` left removed words in the FTS indexes (now optimised first); the persisted-output prefix check failed on a cut inside a character; reruns claimed a large result was "still in your context" when the agent had only seen a 2 KB preview; **`countTokens` froze the daemon for 29–37 s on a 30 KB line of one repeated character** (now 4–35 ms, approximate for such runs); and the first real URL fetch timed out because only the first of two addresses was tried. Retention now removes at most 50 items per task (397 ms for all 657 items of this project's real database in one task before).
- **Bench note:** the new persisted-output rows write ~15 MB of files, which spiked the *next* rows (a pre-existing Read row went from 7 ms to 45 ms p99, and the over-bound row showed a 150 ms outlier); they now run last, and every gate passed three runs in a row. **Still true:** older tests leave about 940 temp folders in /tmp (20 MB): not mine, not fixed. `docs/` is ignored by git, so the ADRs, threat model and support matrix are not in the repository and the README links to them are dead there.
- **Not built:** native manifests for Codex and Gemini CLI (no way to install them into a temporary config here, so they would be unverified claims).
- **Claude Code plugin (2026-11-11): written, validated, installed into a throwaway Claude config, hooks replayed; never run in a live session, not installable until pushed and released.** `.claude-plugin/marketplace.json` + `plugins/sieve` (8 hooks through `hooks/run.sh`, the MCP server, `/sieve:doctor`, `/sieve:stats`, `/sieve:install`). Binaries live in `$SIEVE_HOME/bin` (plugin folders change on update and are deleted on uninstall); `/sieve:install` is the only network call, verified against the release's SHA256SUMS, with `--from <dir>` for local builds. Found while building it: through a plugin, Claude Code names Sieve's tools `mcp__plugin_sieve_sieve__*`, which the pipeline did not recognise as Sieve's own, so `sieve_get` output would have been folded into another receipt; fixed in `toolRef`. Plugin and `sieve setup` hooks together: the shim's plugin route stays silent (`SIEVE_ROUTE=plugin`), setup refuses while the plugin is installed, doctor reports both. Plugin route costs about +2.4 ms p50 per hook (`bench latency`). No icon yet (needed only for a listing in Anthropic's plugin directory).
- **Name.** `sieve` is taken on npm (v0.0.4, unrelated). GitHub org, Homebrew formula, and domain are unchecked. Decide before the first publish; the code uses the name in the binary, socket path, and `~/.sieve`.
- **Go module path** `github.com/sieve-dev/sieve/shim` is a placeholder.
- **Real-agent verification.** Slice 1 is tested against Claude Code's hook JSON as documented and as read from Claude Code 2.1.319, not yet by a live Claude Code session in CI.
- **Release pipeline (2026-11-11): written, run locally, never run on CI.** `.github/workflows/release.yml` on a `v*` tag: tests on Linux and macOS, builds macOS and Linux targets (darwin ad-hoc signed on a macOS runner), `scripts/package.ts` writes archives, bare binaries and `SHA256SUMS`, smoke-tests the packaged linux-x64 archive, and creates a **draft** prerelease (ADR 0015). Windows is built but not released (no daemon transport). Locally: every target built, `shasum -c` passes, a wrong tag is refused, the README install flow runs from an extracted archive (setup dry run), and a packaged binary installed through `sieve upgrade --sha256-file SHA256SUMS`. Not done: Developer ID signing and notarization (needs an Apple account), an install script.
- **Binary size.** `sieve` is 111–136 MB per platform (47–61 MB compressed). On darwin-arm64, 89 MB of it is the Bun runtime that `bun build --compile` embeds; about 20 MB is tree-sitter grammars and about 6 MB is Sieve's JS. No cheap reduction keeps everything local.

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
- Found 2026-11-11: a daemon whose shutdown threw (SIEVE_HOME deleted under it, so SQLite failed the final flush) never exited and spun at 100% CPU; `bun test` leaked one per run through the offline test. Shutdown steps now fail independently and the process always exits (30 s deadline; indexing cut by it resumes through `sieve_search`, since rows stay `indexed = 0`). Stop lets in-flight replies finish (up to 2 s) and then drops connections: measured, `server.close()` otherwise waits forever on a connected client such as an MCP proxy. The daemon also stops itself when its socket file disappears or is replaced. A second leak, found at the same time: the behaviour watcher's detached `log stream` group outlived any owner that died without `stop()` (one per `bun test`); a watchdog in the group now ends it within 2 s of the owner's exit. Measured idle cost after the fix: 0.0–0.4% CPU, about 1.4 wakeups/s, 146 MB. No adaptive tick was added: idle cost is already near zero.
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

## Slice 4: Session log, state block, recall, decisions ✅ (2026-11-11)

| Item | Status | Where / notes |
|---|---|---|
| Session log | ✅ | `core/src/session.ts` (`SessionLog`), `daemon/src/session.ts`. One row per prompt, edit, command, error, decision, index call, todo list; seq per session; migration 4. Long prompts archived as the row's detail. |
| State block, precomputed | ✅ | Pure function of the log (≤ 2 KB, whole lines, long rows → `sieve_resume {"seq":N}`). Rebuilt on the background queue after `turn.end`/`session.end`; delivered on `SessionStart(compact)`, or by gap filling on `compact.before` / the next prompt (ADR 0007). |
| `sieve_resume` | ✅ | No args → the state block; `seq` → one row in full (an archived long prompt verbatim, other details by `sieve_get` id). 8 tools now. |
| Recall pointers | ✅ | `core/src/recall.ts`. Strong terms only (file names, identifiers, known symbols, quoted/error text); ≤ 3 one-line pointers with source, age, `sieve_get` range and stale flag; nothing the current context window saw. Measured: `UserPromptSubmit` with recall p50 2.8 ms / p99 6.8 ms end to end. |
| Decisions with supersession | ✅ | From `AskUserQuestion` answers and approved `ExitPlanMode` plans; per worktree; a newer answer on the same topic supersedes. New sessions start with the decisions in force (≤ 1 KB). |
| Config | ✅ | `[session] state_block`, `recall` (`SIEVE_STATE_BLOCK=0`, `SIEVE_RECALL=0`). |

**Deviations and decisions**
- `session_log` gained `context`, `worktree`, `key`, and a `todo` kind; `decisions` gained `label`; `sessions` gained `epoch_at` and `cleared_seq` (DESIGN §4). "Next steps" come only from the agent's todo list; with no list the section is omitted rather than guessed (ADR 0007).
- Recall does not reuse `sieve_search`: its OR over all words split `auth.ts` into `auth`/`ts` and matched most of the archive. Recall matches file names and identifiers as trigram substrings and phrases as all-words (ADR 0007).
- Named errors (`TypeError: …`) were missed by the fold's `ERROR_LINE` (no word boundary before `Error`), so one in a dropped middle was not lifted into the receipt. `isErrorLine` (which adds them) is now used by the fold, the log extractor, the session log and recall. No captured snapshot changed; a regression test covers it.
- `/clear` starts the state block afresh (rows before it are left out) and delivers nothing; startup delivers only decisions.

**Known gaps carried forward**
- Not yet exercised by a live Claude Code compaction: tested with hook JSON through the real shim and an in-process daemon. The `AskUserQuestion`/`ExitPlanMode` result shapes are taken from the tools' schemas (transcripts were not inspected).
- Decisions approved through permission prompts (`PermissionRequest` hook) or typed as prose are not captured.
- `sieve_resume` over MCP uses the folder's most recent session, like the other tools; two concurrent sessions in one worktree can see each other's state.
- Session-log rows are not removed by retention yet (retention is still unbuilt, slice 1 gap).

## Slice 5: Adapters ✅ built, 🟡 not verified by real runs (2026-11-11)
Codex, Gemini CLI, Copilot CLI, Cursor, OpenCode (in-process). Event-gap filling. Support matrix. Mappings are read from each agent's own docs/types/source (ADR 0008). **All five new adapters are "preview"**: they are tested by replaying each agent's documented payload shapes through the real shim and daemon (and, for OpenCode, the real plugin module), but no real session of any of them has been run. The CI job that would do that (`.github/workflows/agents.yml`, `bun run bench agent-e2e <agent> --run`) is written and unrun: it needs the agents' credentials.

| Item | Status | Where / notes |
|---|---|---|
| Adapter kit + setup registry | ✅ | `packages/adapters/kit`. `sieve setup --agents <list\|all\|detect>`, `status` and `doctor` loop over every adapter; non-verified adapters are labelled. Backup folders are never reused (found: two setups in one millisecond overwrote the first backup, which could hold the only copy of a user's config). Key order no longer counts as a config change. |
| Capabilities: `compaction`, `support`, `contextAt: "tool.after"` | ✅ | `manual-only` compaction → no "unchanged"/hunk reads for that agent. Agents with no context slot on prompts or compaction (Cursor, Copilot CLI) get notes on the next tool result. |
| Gemini CLI (0.65.0) | 🟡 preview | `packages/adapters/gemini-cli`. No replace; log, state, recall, decisions (`ask_user`, `exit_plan_mode`), todos, outline reads, staleness. |
| OpenCode (1.19.4, in-process) | 🟡 preview | `packages/adapters/opencode` + `plugin/sieve.ts`. Real replace, smart reads (declined by throwing), state block into the compaction prompt, synthetic prompt parts, `question` decisions, `todowrite`. |
| Cursor (agent 2026.04.28) | 🟡 preview | `packages/adapters/cursor`. No replace; smart reads via `agent_message`; notes ride on `additional_context` of the next `postToolUse`. Cursor's import of Claude Code hook configs no longer creates a phantom Claude Code session. |
| Codex CLI | 🟡 preview, docs only | `packages/adapters/codex`. No replace, no smart reads (no read tool); state block via `SessionStart(compact)`. Hooks must be trusted inside Codex (`/hooks`). MCP via a managed block in `config.toml` that leaves the user's text untouched. Not installed here. |
| Copilot CLI | 🟡 preview, docs only | `packages/adapters/copilot-cli`. Real replace (`modifiedResult`); own hooks file; notes on the next `postToolUse`. Not installed here. |
| Support matrix | ✅ | `bun run bench matrix` → `docs/support-matrix.md`, from the adapters' declared capabilities plus recorded runs in `docs/e2e/`. States: verified / live (Claude Code) / preview. |
| Real-agent run harness + CI job | 🟡 written, not run | `packages/bench/src/agent-e2e.ts`, `.github/workflows/agents.yml`. Offline parts tested: each agent's project-level config is written into a throwaway repo and passes its own check. |

**Deviations and decisions**
- DESIGN §3's Gemini row was wrong in three places (it has `SessionStart`; `AfterTool` cannot replace cleanly; `PreCompress` fires every turn). OpenCode uses `session.compacting`, not a session-start state. Cursor has no context slot on prompts. Codex has `SessionStart(compact)`.
- Three adapters (Gemini CLI, Cursor, Codex) cannot or should not replace tool output. For them Sieve archives and indexes but the model still sees the full output, so the token saving there is smaller than for Claude Code, OpenCode and Copilot CLI, which can replace. **No savings figure exists yet for any new adapter.**
- Found by testing: a missing `sieve` binary made the OpenCode plugin's `spawn` emit an unhandled `error` event (would have crashed OpenCode); the Claude Code adapter accepted payloads with no `session_id` as a session called "unknown" (what Cursor sends through its Claude-config import); a hand-edited TOML block would not add and remove symmetrically.
- `touchSession` clears `ended_at`: an agent that sends SessionEnd then continues the same session id is live again. Next steps skip `cancelled` todos.

**Known gaps carried forward**
- Real-agent runs for all five new adapters; until then they stay "preview".
- Cursor's base hook fields (`hook_event_name`, `workspace_roots`) and the shape of `tool_output` for non-shell tools are unconfirmed.
- Copilot CLI on Windows needs a `powershell` hook entry.
- Qwen Code, VS Code Copilot, Windsurf, Cline/Roo, Kiro, Zed, Pi, Aider, Goose: slice 12.
- File-change notices call a change "not by your edits" when it came from the agent's own shell scripts; only edits through its edit tools count as its own.

## Slice 6: Sandbox isolation + secret masking 🟡 macOS and masking done; Linux unrun; Windows not built (2026-11-11)

| Item | Status | Where / notes |
|---|---|---|
| Secret masking before storage | ✅ | `core/src/secrets.ts`. Archive, sources, log rows/keys, decisions, command keys, signatures, `sieve_run` output. Known formats, context rules, CLI flags, `.env` values, narrow entropy rule. Zero changes on the 35 captured fixtures, this repo's source and its lockfile (tested). 1.9 MB scanned in ~60 ms. ADR 0009. |
| Seatbelt sandbox (macOS) | ✅ tested here | `packages/sandbox`. Writes limited to project + scratch + grants; network off; credential folders unreadable; environment allowlist. Tested by trying to escape on the real backend: write outside, reach a local server, read a denied folder, leak an env var, outlive the timeout. Also verified with the compiled binary running JS as Bun inside the sandbox. |
| bubblewrap sandbox (Linux) | 🟡 ran once in CI and **failed**; fixed, not yet re-verified on Linux | The first Linux CI run (2026-11-12) executed the real sandbox tests on a runner with bubblewrap and found a real isolation failure: a denied folder inside the project (`vault/`) was readable, because its `--tmpfs` was mounted before the project `--bind` and bubblewrap lets a later mount shadow an earlier one (Seatbelt lets a deny win, which hid this on macOS). Fixed by mounting every deny after the binds, with ordering tests that fail on the old order and run on any machine. **Until a Linux CI run passes, do not rely on Linux isolation.** The `sandbox-linux` job has still not run (it needs the quality job to pass). |
| Landlock + seccomp helper (Linux fallback) | ⬜ | Not started. |
| Windows (AppContainer + Job Object) | ⬜ | `isolation: none (no sandbox backend for win32 yet)`. |
| Per-call grants | ✅ | `sieve_run` takes `network` (hosts), `writable`, `env`. Sanity-checked (never `/`, home, system or credential paths). Not yet checked by Guard (slice 7). |
| Isolation reporting | ✅ | Every run receipt, `sieve doctor`, `sieve status`: the level in force, including `none (<why>)`. `[sandbox] mode = auto \| off \| require`. |
| Resource limits | 🟡 | Timeout (process group kill) and no core dumps. **Memory and process counts are not limited** (ulimit -v breaks JavaScriptCore). |

**Deviations and decisions**
- `network: [hosts]` turns the network on for **all** hosts: neither backend filters by host name. The receipt says "not filtered". Host filtering needs the slice-10 proxy.
- Archive ids stay the hash of the original bytes (so a file's id matches the watcher's content id); the stored text is masked. `sieve_get` is exact **except for `<secret:…>` tokens**: the one stated exception to "nothing is lost".
- Smart reads give the agent its own file unmasked (it must be able to edit it); only the stored copy is masked, and diffs compare masked with masked.
- Bugs found by testing: `realish()` dropped the first letter of a path directly under `/`; extra deny-read paths were not resolved to real paths, so a `SIEVE_HOME` under macOS `/tmp` was silently not denied; a deny covering the project itself broke `getcwd`; `curl -u user:pass` was not recognised; a decision topic containing a secret could never be superseded.

**Known gaps carried forward**
- Linux bubblewrap failed its first real run (see above) and is unverified since the fix; Windows has no backend; Landlock fallback not built.
- Reads are open apart from the credential list.
- Grants are only sanity-checked until Guard (slice 7).
- Masking misses secrets in prose or formats not listed, and does not touch what the agent's own tools print.
- `sandbox-exec` is deprecated by Apple.

## Slice 7: Guard ✅ static analysis, rules, presets, audit, policy-change tracking; behaviour recording on macOS only (2026-11-11)

| Item | Status | Where / notes |
|---|---|---|
| Shell parser | ✅ | `packages/guard/src/shell.ts`. Pipelines, subshells, `$(…)`, backticks, `<(…)`, heredocs, redirects; quoting cannot hide or fake an operator. |
| Wrappers, facts, capabilities | ✅ | `facts.ts`: 65 wrapper entries read through (9 are shells); program, subcommand, flags, paths with operations, hosts/ports, 10 capabilities, git push targets/force; download-and-run, env-dump, fork-bomb patterns. |
| Scripts, Makefile targets, package.json scripts | ✅ static | Read and analysed (depth ≤ 3). **Not** behaviour recording. |
| Rule grammar, scopes, modes | ✅ | `rules.ts`: DESIGN §7 plus `any_flags`, `tool`, `production`, `[settings]`, `[audit]`; `not`/`in` forms. Repos cannot loosen policy (ADR 0010). |
| Presets observe / balanced / locked | ✅ | `presets.ts`: balanced has 25 rules, locked adds 2, observe 1; 115 saved tests run by `sieve guard test`. |
| `ask` / `deny` per agent | ✅ tested on replayed payloads | Ask via the agent's prompt where it has one (Claude Code, Cursor, Copilot CLI); refused with an explanation where not (Gemini CLI, Codex, OpenCode) and for Sieve's MCP tools. |
| Guard on every agent's `tool.before` and on Sieve's MCP tools | ✅ | `daemon/src/guard.ts`. `sieve_run` code and grants (network, writable, env), each `sieve_batch` command, `sieve_read` / `sieve_index` paths. Fails open: an exception inside Guard lets the call through and is counted. |
| Audit log (hash-chained JSONL) | ✅ | `guard/audit.jsonl`; `sieve guard log --verify`. |
| CLI | ✅ | `sieve guard check \| test \| log \| mode \| init`; Guard line in `status` and `doctor`. |
| Behaviour checks inside the sandbox | ✅ macOS · ⬜ Linux, Windows | `sieve_run` only. Rules compile to Seatbelt clauses (deny → kernel refusal in enforce mode; other rules → `(allow … (with report))`); the daemon reads the kernel's report lines and applies the rules to what the code opened, ran or connected to. `daemon/src/behaviour.ts`, `guard/src/behaviour.ts`; `daemon/test/behaviour.test.ts` runs against the real sandbox. Linux/bwrap has no report channel and has never run; Windows has no backend. |
| Loosening needs a recorded reason | ✅ | `policy-state.json` remembers the last policy; any loosening (CLI or a hand edit of `guard.toml`) is written to the audit log as `policy-loosened`, with the reason from `policy-reason.txt` or the file's `reason`. Allow rules require a `reason`. `status`/`doctor` flag unexplained loosening. A broken file falls back to the last good policy. |

**Deviations and decisions**
- **Default mode is enforce** (changed on the user's decision, 2026-11-11; the first pass shipped monitor). With no `guard.toml` the balanced preset blocks. Going back to log-only is `sieve guard mode monitor --reason "why"` and is itself recorded as a loosening.
- **Behaviour tests depend on the OS log.** On the author's laptop the log sometimes drops a Python run's sandbox reports for minutes (about 1 full suite run in 4 before the probe). `daemon/test/behaviour.test.ts` probes at start and, if the log is not delivering, prints `BEHAVIOUR TESTS STOOD DOWN` and does not run its assertions. A green run with that line is not evidence for recording.
- Rule files: `[settings]` and `[audit]` tables added to the grammar; `mode`/`preset` may appear in any scope but only the user's can lower them. The audit trail is a JSONL file, not the `guard_audit` table sketched in DESIGN §4.
- Policy changes are tracked from a state file rather than only the CLI; new rules `balanced.find-delete-system`, `balanced.mv-system`, `balanced.force-with-lease-protected`; matcher `deletes`.
- Found by testing: Copilot CLI sends tool arguments as a JSON string, so Guard saw no command and allowed everything from that agent (fixed in the adapter and in Guard); a registry glob that approved `registry.npmjs.org.evil.example`; `dd if=/dev/sda of=file` flagged as a disk wipe; `git push origin :main` (delete by refspec) not caught; `time` stripped as a keyword before it could be read as a wrapper; `git symbolic-ref` needed where `rev-parse HEAD` fails before a first commit.

**Known gaps carried forward**
- Behaviour recording covers `sieve_run` on macOS only. The agent's own shell tool has no sandbox, so renamed binaries, run-time-built commands and Python/Node script *files* run there get past static analysis. PowerShell and cmd are not parsed.
- Recording limits: attribution uses sampled process-group pids, so while runs overlap a process that lives under ~40 ms can be missed; loopback targets are known by port only; the system log can drop lines under load; only rule shapes verified to report are compiled (others are skipped, not guessed); `list` operations are not reported.
- Behaviour tests depend on the OS log delivering lines; one run in the suite failed once under full-suite load and passed on rerun (three clean full runs after).
- POSIX shells only (no PowerShell/cmd). Unlisted wrappers hide the command they run.
- The audit chain detects edits; it does not prevent them (no signing key).
- Adapters other than Claude Code are preview; their deny/ask formats are unverified by a live session.
- No dashboard view of decisions yet (slice 9).

## Slice 8: Memory + skills ✅ built and tested on replayed payloads and the CLI; not yet seen in a live agent session (2026-11-11)

| Item | Status | Where / notes |
|---|---|---|
| Facts with two timelines, scopes, trust | ✅ | `core/src/memory.ts`; tables `facts`, `predicates` (+`codebase`), `predicate_aliases` in the global DB. Writer caps trust; an agent's "asserted" must be in the user's words. |
| Slot-drift resolution | ✅ | 22 seeded predicates with aliases, trigram matching for predicates (≥0.72) and subjects (≥0.82); `sieve memory review` lists duplicates, unknown predicates, unconfirmed facts. No embeddings. |
| Supersession, retraction, restatement | ✅ | Single-valued predicates close the old row; nothing deleted except `memory prune --yes`. |
| `sieve_remember` / `sieve_recall` | ✅ | Tool list is now ten. Credentials are refused, not masked. |
| Injection | ✅ | Core block (≤8 asserted, no clock) at start / compaction / subagent; relevant block (≤5, word overlap × 30-day half-life × use boost × trust) on first prompt and after compaction. Says the user's message overrides. |
| Capture by rule | 🟡 | Commits, PR URLs, answered-question decisions, explicit remembers. Edited files and tool errors are not facts (they are in the session log). **Model extraction not built** (needs an opt-in model or key). |
| Markdown sync | ✅ | `.sieve/memory/*.md`, edits read back, deletes retract; read-back capped at `observed` (ADR 0011). |
| Facts marked possibly stale when a file they name changes | ✅ (mtime check) | Left out of blocks, flagged by `sieve_recall`. Not driven by the git watcher; facts naming no file are never flagged. |
| Skills: import, checksum, enable/disable, verify | ✅ | Folder and git clone (tested against a local repo; https/ssh not run in the suite). Added disabled; tampered skills refuse to load. |
| Skills: matching and loading | ✅ | BM25 + requested/mentioned check; one per turn; a line says why; not repeated in an epoch. |
| CLI | ✅ | `sieve memory list \| review \| sync \| edit \| prune`; `sieve skills add \| list \| enable \| disable \| remove \| verify \| match`; memory line in `status`. |

**Deviations and decisions**
- `repo` vs `project` scope are defined by us (ADR 0011). `predicates` gained a `codebase` column. `decision` is single-valued per topic so a changed answer replaces the old one.
- Facts live in the global database, not per-project, because `everywhere` crosses projects.

**Known gaps carried forward**
- Retrieval is word overlap (English). A fact that shares no word with the prompt is only found by `sieve_recall`.
- For agents with no prompt context slot, a skill is sent as a pointer to its SKILL.md instead of its text (the 4 KB cap on tool-result notes).
- Latency: first prompt with 40 facts and a matching 3-skill pool measured p99 4.9 ms warm (`bun run bench latency`).

## Slice 9: Steering, TUI, dashboard ✅ built and tested on replayed payloads; not seen in a live agent session (2026-11-11)

| Item | Status | Where / notes |
|---|---|---|
| Output-size history per command family | ✅ | `command_stats` (project DB), updated for every large output of a read-only command. |
| Steering | ✅ | `daemon/src/steer.ts`. Only commands proven read-only (short allow-list, no redirects, writes, network, wrappers); declined **once** (per reader, command, 10 min) when last output − 800 > 2 × 1500 tokens, with a ready `sieve_run` call. Needs an agent that can deny. Off with `[steering] enabled = false` / `SIEVE_STEERING=0`. |
| Persisted fold stats | ✅ | `folds` table: every large output, kind fold / rerun / pass, extractor, tokens in/out, archive id, source (masked). |
| Dashboard | ✅ | `sieve dash` → `packages/dashboard`: 127.0.0.1 only, random token (URL then cookie), Host check, CSP, no external assets. Tokens by agent / tool / extractor / session, receipts with "why cut" and "view original", memory facts with source, Guard decisions, hook health, projects. |
| TUI | ✅ | `sieve tui` (`--once` prints one frame). |
| Quality canary (opt-in) | 🟡 | `[canary] sample` flags a deterministic fraction of folds; the dashboard marks them and "view original" shows the archived original beside the reason. No automatic comparison or scoring. |
| Dollar estimate | ✅ labelled | Tokens saved × `[prices] input_per_mtok` (default $3). A price you set, not a measurement. |
| Cache-hit rate | ⬜ | Shown as "not measured"; only the proxy (slice 10) can measure it. |
| OS notification when hooks stop firing | ⬜ | Not built. `status`/`doctor` and the dashboard show hook health; nothing pushes. |

**Known gaps**
- Recall pointers are shown to the model but not stored, so the dashboard cannot list them.
- Steering's token estimate comes from the last run only; it does not know whether the next run prints the same.
- The dashboard's session grouping is by agent session id as the agent reports it.
## Slice 10: Local proxy ✅ built and tested against a fake upstream; no live provider used (2026-11-11)

| Item | Status | Where / notes |
|---|---|---|
| Anthropic / OpenAI / Gemini endpoints | ✅ shapes from public docs | `packages/proxy`; `sieve proxy`. Forwards the client's own key to the configured upstream (OpenRouter, Ollama, any compatible URL via `[proxy]`). |
| Tool schema trimming + `sieve_schema` | ✅ | Over 1500 B, cut at a sentence, parameters kept; full definition stored in `proxy_schemas`. Tool list is now eleven. |
| Cache marks | ✅ Anthropic | Client marks never removed; up to 3 added in free slots, max 4 total; one retry without them if refused. |
| History: fold on first sight, archive in steps | ✅ Anthropic, OpenAI | Receipts reuse the hook extractors; originals in the proxy archive, expandable with `sieve_get`; edits, thinking blocks, user text, failed and image results untouched. |
| Too-long refusals | ✅ | Limit read from the refusal; one retry with the overshoot + 10% archived. |
| Budgets | ✅ | Session and day, tokens and dollars at list prices you set; warnings at 50/80/100% once each; optional hard stop. |
| Cache-hit rate, proxy summary | ✅ | In `sieve dash` / `sieve tui` from `proxy_calls`. |
| Fail open | ✅ | Transform error → original bytes. Upstream unreachable → 502 (cannot be hidden). |
| Docker / systemd / Worker templates | 🟡 | `deploy/`. Written, not built or run. The Worker only trims and forwards. |

**Known gaps:** see ADR 0012 (no live provider; Gemini minimal; token estimate is characters ÷ 3.6; session identity heuristic).
## Slice 11: Session export/import, encrypted sync, login service, upgrade ✅ built and tested on one machine; never run between real machines or under a real launchd/systemd (2026-11-11)

| Item | Status | Where / notes |
|---|---|---|
| Session export / import | ✅ | `sieve session list \| export \| import`; `core/src/transfer.ts`. Strict validation; masked content only; optional `--encrypt`. |
| Encryption | ✅ | AES-256-GCM, scrypt key, passphrase from env or file (`core/src/seal.ts`). |
| Encrypted sync | ✅ folder-based | `sieve sync init \| push \| pull \| status`; facts (both timelines) and finished sessions; repos matched by git remote. No network call by Sieve. |
| Login service | ✅ generated and tested with a fake runner | `sieve service install \| uninstall \| status [--dry-run]`: launchd agent, systemd user unit, Windows task. Never installed for real in testing. |
| `sieve upgrade` | ✅ | `--from <file\|https url> --sha256 …` or `--sha256-file` (a bare hash, or a `SHA256SUMS` file: the line naming the download is used); runs the new binary first, keeps `.prev`, atomic swap, daemon asked to restart. No self-update check, no signing. |

**Known gaps:** see ADR 0013 (no real two-machine or cloud-folder run; live sessions and skills do not sync; no signing).
## Slice 12: Remaining adapters, embeddings + reranker, paired benchmark, v1.0 🟡 partly built; see what is missing (2026-11-11)

| Item | Status | Notes |
|---|---|---|
| Adapters: Zed, Kiro | 🟡 preview, MCP only | `packages/adapters/mcp-only`. Shapes from each product's docs; never run. A settings file with comments (Zed's default) is read for `status`/`doctor` but never rewritten: setup prints the block to merge by hand. |
| Adapters: Qwen Code, Windsurf, Cline/Roo, VS Code Copilot, Pi, Aider, Goose | ⬜ | No source I could verify; not guessed. |
| Local reranker | 🟡 built, **off** | Hash reranker measured no better than lexical search (ADR 0014). Command provider for a neural embedder you run. No model shipped. |
| Paired benchmark | 🟡 analysis + protocol only | `bun run bench paired`; `docs/bench-protocol.md`. **No agent runs, so no published result.** |
| CONTRIBUTING, CODE_OF_CONDUCT, SECURITY.md, threat model | ✅ | `docs/threat-model.md` is the current one; SECURITY.md no longer carries the slice-1 text. |
| Zero-network default | ✅ tested | Call-site allow-list test + hook flow under a network-denied Seatbelt profile (macOS). |
| Kill/hang fault injection | ✅ | `binary.test.ts`, `shim/main_test.go`. |
| One-command install, no runtime | 🟡 | Release workflow + checksummed archives (open items above); no installer script, no release published yet. |
| Model fact extraction | ✅ opt-in | ADR 0014. |
| OS notification for broken agent config | ✅ opt-in | Config drift only. |
| Linux Landlock + seccomp helper | 🟡 written, never run | Opt-in via `SIEVE_SANDBOX_HELPER=1`. |
| Windows sandbox / daemon | ⬜ | Not built. |
| Real-agent end-to-end for every adapter | ⬜ | Never run. Every adapter but Claude Code is "preview". |

The v1.0 definition of done is **not met**: no installer, no real-agent verification, no benchmark result, no Linux or Windows isolation evidence.
