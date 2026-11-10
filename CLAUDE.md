# Sieve

Local-first context engine for AI coding agents: a per-user daemon (`sieved`) plus a Go hook shim and an MCP stdio proxy. It archives large tool output, returns short deterministic receipts, and makes everything searchable. Apache-2.0.

Read before changing behaviour: [DESIGN.md](DESIGN.md) (protocol, schema, tool schemas), [PLAN.md](PLAN.md) (what each slice ships, current status, deviations), [docs/adr/](docs/adr/). The original brief is [prompt.md](prompt.md); do not edit it.

## Commands
- `bun install` · `bun run build` (dist/sieve + dist/sieve-hook; needs Go) · `bun run build --all` (all release targets)
- `bun test` (runs everything; `binary.test.ts` needs `bun run build` first, and skips without it)
- `bun run typecheck` · `bun run lint` (Biome; Markdown is excluded on purpose)
- `cd shim && go test ./... && go vet ./...`
- `bun run bench` (replay + latency; latency needs dist/)
- From source: `bun packages/cli/src/main.ts <command>`

## Layout
`packages/protocol` frames, events, tool zod schemas · `packages/core` paths, project resolution, SQLite store, chunker, search, tokens, fold/receipts, `src/extract/` format-aware extractors, `fixtures/` real tool output + must-keep facts · `packages/daemon` socket server, hook pipeline, `sieve_run` jobs, tool handlers, client · `packages/adapters/claude-code` hook mapping + setup · `packages/mcp` MCP proxy · `packages/cli` the `sieve` binary · `packages/bench` · `shim/` Go shim.

## Invariants (do not break)
1. **Never block the agent.** The hook path fails open: any error → empty stdout, exit 0, a line in `run/misses.log`. Heavy work (chunking, FTS indexing, DB flushes) goes on the background queue, never the hook path.
2. **Nothing is lost.** Archive the original (`store.put`) before returning anything shortened. Every receipt carries an id that `sieve_get` expands exactly.
3. **Cache-safe.** Receipts are pure functions of their input: no clocks, session ids, counters, or randomness. Archive ids are content-addressed. A test asserts byte-identical receipts across sessions.
4. **Errors are never cut**, only cleaned of terminal codes; error/failure lines in a dropped middle are lifted into the receipt.
5. **Honest.** Never claim isolation, agent support, or savings that tests or CI have not shown. Receipts and `sieve doctor` state `isolation: none` until slice 6.
6. **Local by default.** No network calls unless the user enables them.
7. Tool args are strict zod objects; unknown fields are rejected by name. Tool descriptions stay under 400 characters.

## Gotchas
- Unix socket paths are limited to ~104 bytes on macOS: tests use `mkdtemp("/tmp/sv-")`, not `os.tmpdir()`.
- Tests that host the daemon in-process must spawn subprocesses with async `Bun.spawn`, never `spawnSync` (it blocks the daemon's event loop and every hook times out).
- `SIEVE_HOME` relocates all state; `SIEVE_BIN` tells the shim which binary to start; `SIEVE_HOOK_TIMEOUT_MS` (default 250) and `SIEVE_IDLE_MINUTES` (default 30, 0 = never).
- Never run `sieve setup` without `--dry-run` against the developer's real `~/.claude` in tests or experiments; use temp dirs (`configDir`, `stateFile` options).
- The shim avoids `encoding/json` to stay under its 3 MB budget (`shim/minijson.go`); the build fails if it grows past 3 MB.
- Extractors: add a captured fixture first (extend `packages/core/fixtures/capture.sh`, never hand-edit captured output), list its must-keep facts in `fixtures/index.ts`, then write the extractor. Hand-written fixtures go in `handwritten.py` and stay labelled. Check new fixtures for local paths, usernames and hostnames before committing. Review snapshot diffs; `--update-snapshots` only after reading them.
- Never run `npx <name>` for a tool that is not installed locally: npx downloads whatever package has that name. Call `node_modules/.bin/<tool>`.
- The live daemon serves the developer's real agent sessions from `dist/`. After rebuilding, `./dist/sieve daemon stop` so the next hook starts the new build.
- Write ADRs in `docs/adr/` for decisions with trade-offs; update PLAN.md status and deviations when a slice changes.
