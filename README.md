# Sieve

Sieve is a local context engine for AI coding agents, licensed under Apache-2.0. A daemon on your machine archives large tool output and gives the agent a short receipt instead. It also lets the agent search everything it has seen and expand any archived output back to the exact original bytes. Nothing leaves your machine.

**Status: pre-1.0.** Slices 1 to 11 are built and tested; slice 12 is partly built. It is exercised with Claude Code only; every other adapter is "preview" (written from documentation or installed sources, never run in a live session). `sieve_run` is sandboxed on macOS only. No benchmark of agent task success has been run, so there is no published claim about it beyond the replay measurement of tool output. [PLAN.md](PLAN.md) is the honest list of what is built and what is not; [docs/threat-model.md](docs/threat-model.md) says where each protection stops.

## What happens today
- When a tool prints more than 4 KB (Bash, Grep, MCP tools, web fetches), Claude Code receives a receipt instead. If Sieve recognises the format (test runners, compilers and linters, package managers, git, JSON, HTML, logs, search results), the receipt keeps every failure and error whole and drops the noise around them: passing tests, repeated diagnostics (every location stays listed), library stack frames, progress lines. Otherwise it keeps the start and end, error lines from the middle, and lines matching what the agent said it wanted. File reads go through smart reads (below).
- `sieve_get` returns the exact original output, either whole or as a line range. `sieve_search` searches everything archived in the project. Results are ranked by words and by partial names, with newer items first, and a misspelled word is corrected from the words in the index.
- `sieve_batch` runs several commands and returns only the parts of their output that answer your questions.
- `sieve_run` runs a script and returns at most 16 KB of its output; anything larger is archived. On macOS it runs in a Seatbelt sandbox (writes limited to the project, network off, credentials unreadable); on Linux and Windows it runs as you, and every receipt and `sieve doctor` says which applies.
- Hooks typically take about 2 ms. If the daemon is down or slow, the agent gets the raw output and Sieve logs a miss. Sieve never blocks the agent.

- **Smart reads.** The first full read of a file over 16 KB returns its outline and the lines that match your latest request; reading it again returns the whole file. Re-reading a file that has not changed since the agent read it says so instead of resending it, and a file that changed a little returns only the changed lines. Subagents and compacted sessions are tracked separately, so Sieve never claims the agent still has something it lost. Turn this off with `reads.smart = false` in `~/.sieve/config.toml`.
- **Reruns.** Running the same command again and getting the same output returns one line instead of the output. A test or build rerun says what was fixed, what is new and what still fails.
- **Staleness.** When files the agent read change on disk (your edits, a `git checkout`), the next prompt tells it which ones, and why if git did it.
- A background watcher keeps a symbol index of the repo, so `sieve_search` also finds functions and classes by name.

Measured numbers, losses included: [slice 3](docs/bench/slice-3.md), [slice 2](docs/bench/slice-2.md), [slice 1](docs/bench/slice-1.md).

## Claude Code plugin
Not installable yet: these commands work once this repository is pushed to GitHub and v0.1.0 is released.

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

Status: the plugin passes `claude plugin validate --strict` and installs into a throwaway Claude Code config, and its hooks have been replayed through the shim and daemon. It has not been run in a live Claude Code session.

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
