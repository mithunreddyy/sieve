# Sieve

Sieve is a local context engine for AI coding agents, licensed under Apache-2.0. A daemon on your machine archives large tool output and gives the agent a short receipt instead. It also lets the agent search everything it has seen and expand any archived output back to the exact original bytes. Nothing leaves your machine.

**Status: pre-1.0.** Slices 1 to 11 are built and tested; slice 12 is partly built. Verified live with Claude Code only, in small headless sessions (see [Results](#results)); every other adapter is "preview" (written from documentation or installed sources, never run in a live session). `sieve_run` is sandboxed on macOS only: the Linux sandbox failed its first real CI run, is fixed, and has not been re-verified. The results below are small runs on one cheap model: a direction, not a guarantee. [PLAN.md](PLAN.md) is the honest list of what is built and what is not; [docs/threat-model.md](docs/threat-model.md) says where each protection stops.

## How it works

An AI coding agent runs tools (shell commands, searches, file reads, web fetches) and everything they print goes into the model's context window. The window is re-read on every later turn, so one 20 KB test log is paid for again and again. Sieve sits between the tools and the model and keeps the part that matters.

```
 Claude Code ──hook──▶ sieve-hook (Go, 2.3 MB) ──unix socket──▶ sieved (daemon) ──▶ SQLite archive
     ▲                   passes through if the daemon             │  chunks + FTS5 search, per project
     │                   is down: never blocks the agent         │  every output stored whole, by hash
     └──── receipt, plus a note of matching lines ◀──────────────┘
 Claude Code ──MCP──▶ sieve mcp ──▶ sieved      sieve_get · sieve_search · sieve_read · sieve_run · …
```

**One tool result, step by step**

1. The agent runs a command. Claude Code calls Sieve's `PostToolUse` hook with the result.
2. The hook (a small Go program, about 2 ms to answer) forwards it to the daemon. If the daemon is down, slow or errors, the agent gets the original output unchanged and Sieve logs a miss. Sieve never blocks the agent.
3. The daemon **archives the original first**: secrets are masked, the text is compressed, and its id is the hash of the original bytes. Only then does it decide what to send.
4. Under about 4 KB, or if a receipt would not save at least 768 characters and 10%, the output passes through.
5. Otherwise the agent receives a **receipt**: a short, deterministic summary with the id of the full output. Which summary depends on what the output is (below).
6. The agent can expand any receipt exactly with `sieve_get` (whole, or a line range), or search everything archived with `sieve_search`.

A real receipt, from a 320-line test run in no known format (22 KB, 6,082 tokens, one failure in the middle). The receipt is 169 tokens:

```
[sieve s_3dblwo7re6jh] 6,082 tokens (o200k_base), 320 lines
extractor: repeats · dropped: 319 lines folded into 1 repeating template
───
320 lines in 2 templates:
319× PASS src/module<n>/case<n>.test.ts > handles input variant <n> (<n> ms)   (L1–L320)
L172: FAIL src/auth/token.test.ts > rejects an expired token: expected status 401, received 200
───
Full output archived (22 KB). Expand: sieve_get {"id":"s_3dblwo7re6jh"}, or a range: {"id":"s_3dblwo7re6jh","lines":"a-b"}
Do not re-run the command to see more.
```

**What the receipt keeps depends on the output**

| Output | What Sieve does |
|---|---|
| Test runners (vitest, pytest, go, junit, playwright), compilers and linters (eslint, biome, ruff, mypy, clang, rustc) | Every failure and error whole; passing tests, repeated diagnostics (every location stays listed) and library stack frames dropped |
| git (log, diff), JSON, HTML, search results, logs | A format-aware summary: file list with the hunks over budget left in the archive, JSON shape and values, HTML as Markdown, matches grouped by file with line numbers, log lines folded into templates |
| Anything repetitive that none of the above recognises | Lines grouped by template (words kept, numbers folded). A template seen 3+ times prints once with its count and line range; the **rare lines print verbatim**, which is usually the one that matters. Error lines are never folded away |
| Anything else | Start and end, error lines from the middle, and lines matching the command's stated intent |
| Errors | Never cut, only cleaned of terminal codes |

**The rest of what it does**

- **Lines that answer your question.** A receipt must not depend on anything but the output (this is what keeps it cache-safe and reproducible), so it cannot know what you asked. A separate short note can. After a receipt replaces an output, Sieve adds an 800-byte note with the *exact lines* that match the rare words of your last request (an id, a port, a migration name; words found in more than 5% of the lines say nothing and are ignored), with line numbers and the archive id, so the agent usually needs no second command. It is not sent to subagents or for web pages, and only when receipt plus note is clearly smaller than the output.
- **Smart reads.** The first full read of a file over 16 KB returns its outline and the lines that match your latest request; reading it again returns the whole file. Re-reading a file that has not changed says so instead of resending it, and a file that changed a little returns only the changed lines. Subagents and compacted sessions are tracked separately, so Sieve never claims the agent still has something it lost.
- **Reruns.** Running the same command again and getting the same output returns one line. A test or build rerun says what was fixed, what is new and what still fails.
- **Staleness and recall.** When files the agent read change on disk (your edits, a `git checkout`), the next prompt says which. A prompt naming a file or symbol gets pointers to earlier output about it, once. After compaction a state block of at most 2 KB (goal, open errors, decisions, next steps) restores the thread.
- **Search.** Archived output, files read and the repo's symbols are searchable: words and partial names are ranked together, newer first, and a misspelling is corrected from the words in the index.
- **`sieve_batch` and `sieve_run`.** Run several commands, or a script, and get back only what answers your questions (at most 16 KB, the rest archived). On macOS `sieve_run` is sandboxed (writes limited to the project, network off, credentials unreadable); on Linux it is not yet trustworthy (see below), and every receipt and `sieve doctor` states the isolation actually in force.
- **Memory and a rule engine.** Long-term facts with trust levels, and Guard, which reads each tool call before it runs and blocks or asks (for example, downloading and running a script, or force-pushing a protected branch).

**Claude Code specifics, measured in live sessions (2.1.319), not assumed**

- Claude Code cuts a Bash result at about 30,000 bytes *before any hook runs*, keeps the whole of it in a file, and shows the model only a **2 KB preview, with or without Sieve**. For those results Sieve reads the whole result from Claude Code's own file (only from that session's own folder, a regular file of the size Claude Code reported, up to 256 KiB), archives all of it, and builds a receipt that fits inside the 2 KB the model will see, errors and the way to expand it included. Savings on these results are counted against the 2 KB preview, not the full output, so they come out close to zero: what Sieve adds there is a complete archive, exact expansion and search, not fewer tokens.
- WebFetch results arrive as `{bytes, code, codeText, durationMs, result, url}`. Sieve replaces `result` with a receipt. (Before it did, Sieve was counting WebFetch savings that never reached the model.)
- A hook can replace a tool's output and add a note in the same reply, and Claude Code honours both.
- MCP tool schemas are loaded on demand by Claude Code (seen live: the agent had to load `sieve_get` before it could call it), so they are not paid for up front.

**Rules it keeps**

1. Never block the agent: any hook error means the original output, exit 0.
2. Nothing is lost: the original is archived before anything shorter is returned, and every receipt carries an id that `sieve_get` expands exactly (secrets are masked before storage, so a raw secret never reaches the database).
3. Receipts are pure functions of the tool output: no clocks, session ids or counters, so they never disturb the model's prompt cache. A test asserts byte-identical receipts across sessions.
4. Errors are never cut.
5. Honest: it states the isolation in force, and claims no agent support or saving that a test has not shown.
6. Local by default: no network call unless you enable one (web indexing, the proxy, `sieve upgrade`).

## Results

**Short version.** Against plain Claude Code, on tasks whose output Sieve could shorten, Sieve lowered cost by **33% on the tasks it was tuned on and by 7% on tasks it was not**, with every answer still correct (50 of 50 Haiku runs in each arm). The held-out 7% is the number to trust. Gains are concentrated in commands that print a lot; where an agent mostly uses small tools (grep, reading files), there is little to shorten. These are small, headless runs on a cheap model (below); read them as a direction, not a guarantee.

### How it was measured

Three layers, each answering a different question.

1. **Replay (what does a receipt keep?).** 35 real tool outputs (captured from real vitest, jest, pytest, go, eslint, biome, ruff, mypy, clang, git, npm, rg, JSON and HTML runs; 4 written by hand and labelled) go through the real fold code. For each, the benchmark checks that every must-keep fact (a failing test's name, a file and line, an error message) is still visible to the agent, and counts tokens. The baseline is **what Claude Code alone would show**: whole output under 30 KB, a 2 KB preview above it. (An earlier version compared against the raw output, which overstated the saving; see below.) Tokens are counted with the `o200k_base` tokenizer, a proxy for Anthropic's.
2. **Hook latency (what does it cost the agent per call?).** Real `sieve-hook` processes against a real daemon, p50/p99 of the whole round trip.
3. **Live paired runs (does a whole task get cheaper, and still right?).** Real `claude -p` sessions on a fixed set of tasks, each run with and without Sieve and compared pair by pair. All numbers come from Claude Code's own usage report for each run.
   - *Same environment in both arms:* your other plugins and hooks are switched off for these runs only (they add context to every session, which would have made the comparison about them rather than about Sieve); the baseline has Sieve's hooks dead and no MCP server; every task project is a fresh git repository; the Sieve arm has only Sieve's MCP server.
   - *Tasks:* each has output in the 4–30 KB band and one checkable answer. **Dev set** (6 tasks: a test run with one failure, a grep for one definition, a server log with one 500, a JSON list with one record asked for, a config dump with one value, a migration log with one named failure) is what the algorithm was tuned on. **Held-out set** (4 multi-step tasks: a failing build then the source line, two logs to correlate, a fix and rerun, a license search then an import search) was written *before* the tuning and run *once* at the end.
   - *Metrics, fixed before the runs:* cost and the size of the context at the last turn (primary); turns and correctness (secondary). Five runs per task per arm; the tool-call sequence of every run is recorded, so an extra turn can be explained.
   - *Model:* Claude Haiku. A small Sonnet subset checks that it is not a Haiku quirk.

### Replay: what a receipt keeps

Selected rows of the 35 (`bun run bench replay` prints all of them). "Claude Code alone" is what the model sees without Sieve:

| Output | Output tokens | Claude Code alone | With Sieve | Saved vs Claude Code | Facts kept |
|---|---:|---:|---:|---:|---|
| ruff, many duplicates | 7,370 | 7,370 | 1,915 | 74% | yes |
| pytest, verbose, two failures | 4,190 | 4,190 | 849 | 80% | yes |
| go test, verbose | 1,752 | 1,752 | 172 | 90% | yes |
| git diff, 71 files (190 KB) | 53,058 | 594 *(2 KB preview)* | 465 | 22% | yes |
| ripgrep, 800 matches | 23,983 | 625 *(preview)* | 512 | 18% | yes |
| npm view (JSON, 87 KB) | 46,344 | 1,128 *(preview)* | 615 | 45% | yes |
| github issues (JSON) | 46,371 | 656 *(preview)* | 444 | 32% | yes |
| passing vitest run | 681 | 681 | 681 | 0% (passes through) | yes |

**Totals:** 49,865 → 23,366 tokens (**53% fewer than Claude Code alone**), 1 fact lost with Sieve against 2 with Claude Code alone, and none where Sieve loses a fact Claude Code alone would have shown (the benchmark fails if it does). Measured against the raw output instead, the same replay reads 81%; that figure is not what a user gets.

The replay also exposed a JSON receipt whose body came out empty (its first line was longer than the whole budget), which is fixed. One fact (`page20.js:3:9` in the biome output) is shown by neither arm: a 2 KB window cannot hold it. That is a limit, not something fixed.

### Hook latency

Whole round trip, exec to stdout, on an Apple-silicon Mac (`bun run bench latency`; the release gate is warm p99 ≤ 30 ms):

| Case | p50 | p99 |
|---|---:|---:|
| Small `PreToolUse` (almost every call) | 2–2.5 ms | 3–4 ms |
| 60 KB output → receipt | 10 ms | 19 ms |
| 60 KB output kept in a file by Claude Code → 2 KB receipt | 6–9 ms | 15 ms |
| 250 KB output kept in a file | 17 ms | 35–44 ms |
| Same, through the Claude Code plugin's launcher | +2.4 ms | |
| Fallback when the Go shim is missing (`sieve hook`) | 32 ms | 36 ms |

### Live paired runs

**Dev set** (the tasks it was tuned on), Haiku, 5 runs per task and arm:

| Task | Cost without → with Sieve | Final-turn context | Turns | Correct (without · with) |
|---|---:|---:|---|---|
| test run, one failure | −38% | −19% | 2.0 / 2.0 | 5/5 · 5/5 |
| migration log, one failure | −40% | −20% | 2.0 / 2.0 | 5/5 · 5/5 |
| server log, one 500 | −36% | −20% | 2.0 / 2.2 | 5/5 · 5/5 |
| config dump, one value | −36% | −21% | 2.0 / 2.2 | 5/5 · 5/5 |
| JSON list, one record | −26% | −15% | 2.0 / 2.4 | 5/5 · 5/5 |
| grep, one definition | −19% | −7% | 2.0 / 2.2 | 5/5 · 5/5 |
| **All six** | **−33%** | **−17%** | | **30/30 · 30/30** |

**Held-out set** (written first, run once), Haiku, 5 runs per task and arm:

| Task | Cost without → with Sieve | Final-turn context | Turns | Correct (without · with) |
|---|---:|---:|---|---|
| failing build → read the source line | −16% | −11% | 3.0 / 3.0 | 5/5 · 5/5 |
| fix a bug and rerun the tests | −11% | −9% | 4.6 / 5.2 | 5/5 · 5/5 |
| license search → find the importer | −2% | −3% | 3.4 / 3.8 | 5/5 · 5/5 |
| correlate two logs | **+4%** | +1% | 3.8 / 4.0 | 5/5 · 5/5 |
| **All four** | **−7%** | **−6%** | | **20/20 · 20/20** |

Sonnet, two of the held-out tasks, 2 runs each: cost −8% (fix and rerun −16%, correlate +1%), 4/4 correct in both arms.

**Reading the two tables together.** The dev gain was partly the algorithm fitting its own tasks. The held-out run is the honest size of the effect: modest, positive on three of four tasks, and a small loss on one. The tool-call sequences explain the difference. On the held-out tasks the agent mostly reached for Grep, Read and Glob, whose results are small, or (Read) are deliberately not folded, so there was little for Sieve to shorten; its gains concentrate in large Bash output.

### How the numbers moved

Each step is something the benchmark found, then fixed. The earlier runs used a different environment and fewer repetitions, so only the last row is comparable to the tables above.

| Step | What was found | Result |
|---|---|---|
| First paired run (8 pairs) | The JSON task *cost 20% more* with Sieve: the receipt dropped the one record, and the agent spent two extra turns fetching it | cost −9% overall |
| Lines-matching-the-request note | A receipt cannot depend on the prompt, so a separate note carries the matching lines | JSON task −28% in tokens written to context; 12 pairs: cost −14%, 12/12 correct |
| Trace of every tool call | On a fresh session the daemon was not running yet, so it lost the session's first prompt (the task itself) and could never match anything; the agent also re-ran commands to double-check the note | Hooks that fail now keep the first prompt for the daemon to replay; the note names the archive id and says no re-run is needed |
| Five runs per task | Two tasks were still losing (+13%, +10%): hundreds of near-identical lines in no known format fell back to head-and-tail, which hid the one failure | The repetitive-output extractor above |
| After all of it (dev, 30 pairs) | | cost **−33%**, 30/30 correct |
| Held-out (written first, run once) | | cost **−7%**, 20/20 correct |

### What the results do not show

- **Not an end-to-end guarantee.** 5 runs per task, 6 and 4 tasks, tasks of 2 to 5 turns on a small model. Real sessions are longer; a shortened result is re-read on every later turn, so savings may be larger there, and a wrong turn may cost more. The paired analysis in the repo says plainly when a sample is too small to detect a drop in success.
- **Correctness held (50 of 50 per arm), but only on these tasks**, which have one checkable answer. Nothing here measures whether a receipt ever misleads an agent on open-ended work.
- **Large Bash output (over about 30 KB) saves close to nothing in Claude Code**, because Claude Code already shows a 2 KB preview. The savings are in the 4–30 KB band, in WebFetch and MCP results, and in smart reads (replayed, not yet measured in the live runs).
- **Cost is in dollars as reported by Claude Code for Haiku**; token counts in the replay use a proxy tokenizer.
- **Other agents, and Linux isolation.** Only Claude Code has been run live. Every other adapter is "preview". The Linux sandbox failed its first real run in CI (a denied folder inside the project was readable); it is fixed and covered by ordering tests, but no Linux run has passed since, so do not rely on Linux isolation.
- **No comparison with other context tools** was run, so no claim is made about them.

### Reproduce

```sh
bun run build
bun run bench replay        # the 35-output replay and the fact check (fails if Sieve loses a fact Claude Code would show)
bun run bench latency       # hook latency and its gates
# live paired runs need the `claude` CLI and spend real money (about 0.5 cent per run on Haiku):
python3 -I packages/bench/live/bench.py --set dev --reps 5 --parallel 4 --out /tmp/dev.jsonl
python3 -I packages/bench/live/report.py /tmp/dev.jsonl
python3 -I packages/bench/live/report.py packages/bench/live/results/dev-haiku.jsonl    # the stored dev results
python3 -I packages/bench/live/report.py packages/bench/live/results/heldout-haiku.jsonl  # the stored held-out results
```

The raw per-run results (cost, tokens, turns, correctness, every tool call) are in [packages/bench/live/results/](packages/bench/live/results/), and the tasks are in [packages/bench/live/](packages/bench/live/).

## Removing data, and indexing web pages
- `sieve purge --session <id> | --project | --older-than <days>` removes archived output. It is a dry run until you add `--yes`, and it says "removed" only after compacting the database. Memory facts, exports and backups are not touched. By default nothing is ever removed; `[archive] retention_days = N` in `~/.sieve/config.toml` removes items unread for N days, and an id that was removed says so when expanded instead of failing as unknown.
- `sieve_index` can fetch a web page (`url`), but only if you set `[fetch] enabled = true`. It reads https pages on public hosts only, connects to the address it checked, re-checks every redirect, and stores the page as untrusted text. See [docs/adr/0019-indexing-a-web-page.md](docs/adr/0019-indexing-a-web-page.md).
- `sieve stats` reports all-time totals for the project as well as the current daemon's.

## Claude Code plugin
The marketplace is on GitHub, but no release has been published, so `/sieve:install` has nothing to download yet (it would get a 404). Until v0.1.0 is released, install the plugin and then use a local build: `/sieve:install --from <folder with sieve and sieve-hook>`.

**Install** (in your terminal):

```sh
claude plugin marketplace add mithunreddyy/sieve
claude plugin install sieve@sieve
```

Or in one step from Claude Code 2.1.275 on: `/plugin install sieve --marketplace mithunreddyy/sieve`.

Then, inside Claude Code, run `/sieve:install` once. It downloads the release that matches the plugin's version, checks it against the release's `SHA256SUMS`, and puts `sieve` and `sieve-hook` in `~/.sieve/bin`. That is the only network call the plugin makes, and only when you run it (Claude cannot start it on its own). To use a local build instead: `/sieve:install --from <folder>`. Hooks work from the next tool call; Sieve's MCP tools start once Claude Code reconnects to the server, so run `/mcp` and reconnect `sieve`, or restart Claude Code.

**Check:** `/sieve:doctor`. **Savings:** `/sieve:stats`.

**Update:** `claude plugin update sieve@sieve`, then `/sieve:install`. **Remove:** `claude plugin uninstall sieve@sieve`. Your archive, memory and binaries stay in `~/.sieve`; delete that folder to remove them too.

The plugin registers Sieve's 8 hooks, its MCP server (11 tools) and three commands. If you already ran `sieve setup --agents claude-code`, remove that first with `sieve setup --remove --agents claude-code`. If both are installed, the plugin's hooks stay silent and `/sieve:doctor` says so.

Status: the plugin passes `claude plugin validate --strict`, installs into a throwaway Claude Code config, and its hooks have been replayed through the shim and daemon. One headless live Claude Code session loaded it (with `--plugin-dir`, alongside `sieve setup`'s hooks): its MCP server connected, its tools appeared as `mcp__plugin_sieve_sieve__*`, and `sieve_get` through it returned exact lines. The plugin acting on its own, without `sieve setup`'s hooks, has not been run live.

## Install a release
No release has been published yet. Each release will ship, for macOS (arm64, x64) and Linux (x64, arm64), an archive with `sieve` and `sieve-hook`, the bare `sieve` binary for upgrades, and a `SHA256SUMS` file. There is no Windows release: its daemon transport is not built.

```sh
curl -LO https://github.com/mithunreddyy/sieve/releases/download/v0.1.0/sieve-0.1.0-darwin-arm64.tar.gz
curl -LO https://github.com/mithunreddyy/sieve/releases/download/v0.1.0/SHA256SUMS
shasum -a 256 -c SHA256SUMS --ignore-missing
tar -xzf sieve-0.1.0-darwin-arm64.tar.gz
# setup writes these binaries' absolute paths into the agent's config: put them somewhere permanent first
mkdir -p ~/.local/bin && mv sieve-0.1.0-darwin-arm64/sieve sieve-0.1.0-darwin-arm64/sieve-hook ~/.local/bin/
~/.local/bin/sieve setup --agents claude-code --dry-run
```

macOS binaries are ad-hoc signed, not notarized: a file downloaded with a browser is blocked by Gatekeeper (`curl` downloads are not; otherwise `xattr -d com.apple.quarantine sieve sieve-hook`). Later versions: `sieve upgrade --from <url of sieve-darwin-arm64> --sha256-file SHA256SUMS`. Only macOS arm64 has been run with an agent; the other builds are cross-compiled and untested.

## Build and try
Requirements: [Bun](https://bun.sh) 1.4+ and Go 1.23+ to build. The built binaries need no runtime.

```sh
bun install
bun run build                              # dist/sieve and dist/sieve-hook
./dist/sieve setup --agents claude-code --dry-run   # shows exactly what it would change
./dist/sieve setup --agents claude-code             # backs up, writes, checks, rolls back on failure
./dist/sieve status
./dist/sieve doctor
```

Undo with `./dist/sieve setup --remove`, which removes only Sieve's own entries. To restore the backup that setup printed instead, use `./dist/sieve setup --restore <dir>`.

## Docs
- [DESIGN.md](DESIGN.md): architecture, daemon protocol, events, per-agent hook map, SQLite schema, MCP tool schemas, the extractor interface, and the Guard rule grammar
- [docs/adr/](docs/adr/): design decisions and their reasons
- [SECURITY.md](SECURITY.md): threat model and its current limits
