# Sieve

Sieve is a local context engine for AI coding agents, licensed under Apache-2.0. A daemon on your machine archives large tool output and gives the agent a short receipt instead. It also lets the agent search everything it has seen and expand any archived output back to the exact original bytes. Nothing leaves your machine.

**Status: early (slice 3 of 12).** It works with Claude Code. Not built yet: session memory and recall, sandboxing, Guard, other agents, and the proxy. [PLAN.md](PLAN.md) lists what is built and what is not.

## What happens today
- When a tool prints more than 4 KB (Bash, Grep, MCP tools, web fetches), Claude Code receives a receipt instead. If Sieve recognises the format (test runners, compilers and linters, package managers, git, JSON, HTML, logs, search results), the receipt keeps every failure and error whole and drops the noise around them: passing tests, repeated diagnostics (every location stays listed), library stack frames, progress lines. Otherwise it keeps the start and end, error lines from the middle, and lines matching what the agent said it wanted. File reads go through smart reads (below).
- `sieve_get` returns the exact original output, either whole or as a line range. `sieve_search` searches everything archived in the project. Results are ranked by words and by partial names, with newer items first, and a misspelled word is corrected from the words in the index.
- `sieve_batch` runs several commands and returns only the parts of their output that answer your questions.
- `sieve_run` runs a script and returns at most 16 KB of its output; anything larger is archived. **It is not sandboxed yet:** the script runs as you.
- Hooks typically take about 2 ms. If the daemon is down or slow, the agent gets the raw output and Sieve logs a miss. Sieve never blocks the agent.

- **Smart reads.** The first full read of a file over 16 KB returns its outline and the lines that match your latest request; reading it again returns the whole file. Re-reading a file that has not changed since the agent read it says so instead of resending it, and a file that changed a little returns only the changed lines. Subagents and compacted sessions are tracked separately, so Sieve never claims the agent still has something it lost. Turn this off with `reads.smart = false` in `~/.sieve/config.toml`.
- **Reruns.** Running the same command again and getting the same output returns one line instead of the output. A test or build rerun says what was fixed, what is new and what still fails.
- **Staleness.** When files the agent read change on disk (your edits, a `git checkout`), the next prompt tells it which ones, and why if git did it.
- A background watcher keeps a symbol index of the repo, so `sieve_search` also finds functions and classes by name.

Measured numbers, losses included: [slice 3](docs/bench/slice-3.md), [slice 2](docs/bench/slice-2.md), [slice 1](docs/bench/slice-1.md).

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
