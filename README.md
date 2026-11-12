# Sieve

Sieve is a local context engine for AI coding agents, licensed under Apache-2.0. A daemon on your machine archives large tool output and gives the agent a short receipt instead. It also lets the agent search everything it has seen and expand any archived output back to the exact original bytes. Nothing leaves your machine.

**Status: pre-1.0.** Slices 1 to 11 are built and tested; slice 12 is partly built. It is exercised with Claude Code only (one headless live session so far, see PLAN.md); every other adapter is "preview" (written from documentation or installed sources, never run in a live session). `sieve_run` is sandboxed on macOS only. No benchmark of agent task success has been run, so there is no published claim about it beyond the replay measurement of tool output. [PLAN.md](PLAN.md) is the honest list of what is built and what is not; [docs/threat-model.md](docs/threat-model.md) says where each protection stops.

## What happens today
- When a tool prints more than 4 KB (Bash, Grep, MCP tools, web fetches), Claude Code receives a receipt instead. If Sieve recognises the format (test runners, compilers and linters, package managers, git, JSON, HTML, logs, search results), the receipt keeps every failure and error whole and drops the noise around them: passing tests, repeated diagnostics (every location stays listed), library stack frames, progress lines. Otherwise it keeps the start and end, error lines from the middle, and lines matching what the agent said it wanted. File reads go through smart reads (below).
- `sieve_get` returns the exact original output, either whole or as a line range. `sieve_search` searches everything archived in the project. Results are ranked by words and by partial names, with newer items first, and a misspelled word is corrected from the words in the index.
- `sieve_batch` runs several commands and returns only the parts of their output that answer your questions.
- `sieve_run` runs a script and returns at most 16 KB of its output; anything larger is archived. On macOS it runs in a Seatbelt sandbox (writes limited to the project, network off, credentials unreadable); on Linux and Windows it runs as you, and every receipt and `sieve doctor` says which applies.
- **Large Bash output in Claude Code.** Claude Code cuts a Bash result at about 30 KB before any hook runs, keeps the whole of it in a file, and shows the model only a 2 KB preview, with or without Sieve (measured live). For those results Sieve archives the whole output, puts the id, the way to expand it and any errors from the whole output inside that 2 KB, and counts its savings against the preview, so it saves no tokens there. Between 4 KB and about 30 KB, receipts replace the output and do save tokens.
- Hooks typically take about 2 ms. If the daemon is down or slow, the agent gets the raw output and Sieve logs a miss. Sieve never blocks the agent.

- **Smart reads.** The first full read of a file over 16 KB returns its outline and the lines that match your latest request; reading it again returns the whole file. Re-reading a file that has not changed since the agent read it says so instead of resending it, and a file that changed a little returns only the changed lines. Subagents and compacted sessions are tracked separately, so Sieve never claims the agent still has something it lost. Turn this off with `reads.smart = false` in `~/.sieve/config.toml`.
- **Reruns.** Running the same command again and getting the same output returns one line instead of the output. A test or build rerun says what was fixed, what is new and what still fails.
- **Staleness.** When files the agent read change on disk (your edits, a `git checkout`), the next prompt tells it which ones, and why if git did it.
- A background watcher keeps a symbol index of the repo, so `sieve_search` also finds functions and classes by name.

Measured numbers, losses included: [slice 3](docs/bench/slice-3.md), [slice 2](docs/bench/slice-2.md), [slice 1](docs/bench/slice-1.md).

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
