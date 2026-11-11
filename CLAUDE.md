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
`packages/protocol` frames, events, tool zod schemas · `packages/core` paths, project resolution, SQLite store, chunker, search, tokens, fold/receipts, `src/extract/` format-aware extractors, `fixtures/` real tool output + must-keep facts · `packages/daemon` socket server, hook pipeline, `sieve_run` jobs, tool handlers, client · `packages/adapters/*` one per agent (hook mapping + setup; `kit` is the shared setup machinery; start from ADR 0008) · `packages/core/src/memory*.ts` + `skills.ts` long-term facts, Markdown sync, skills registry (ADR 0011) · `packages/guard` shell parser, facts, rules, presets, audit (ADR 0010) · `packages/sandbox` Seatbelt/bwrap isolation · `packages/mcp` MCP proxy · `packages/cli` the `sieve` binary · `plugins/sieve` + `.claude-plugin/marketplace.json` the Claude Code plugin (hooks.json must match the claude-code adapter's EVENTS; plugin.json version must match SIEVE_VERSION; both are tested) · `packages/bench` · `shim/` Go shim.

## Invariants (do not break)
1. **Never block the agent.** The hook path fails open: any error → empty stdout, exit 0, a line in `run/misses.log`. Heavy work (chunking, FTS indexing, DB flushes) goes on the background queue, never the hook path.
2. **Nothing is lost.** Archive the original (`store.put`) before returning anything shortened. Every receipt carries an id that `sieve_get` expands exactly, except that secrets are masked before storage (`<secret:kind#N>`; raw secrets never reach the database, see ADR 0009). The archive id is the hash of the original bytes.
3. **Cache-safe.** Receipts are pure functions of their input: no clocks, session ids, counters, or randomness. Archive ids are content-addressed. A test asserts byte-identical receipts across sessions.
4. **Errors are never cut**, only cleaned of terminal codes; error/failure lines in a dropped middle are lifted into the receipt.
5. **Honest.** Never claim isolation, agent support, or savings that tests or CI have not shown. Receipts, `sieve doctor` and `sieve status` state the isolation actually in force, including `none (<why>)`. Linux (bwrap) has never run and Windows has no backend.
6. **Local by default.** No network calls unless the user enables them.
7. Tool args are strict zod objects; unknown fields are rejected by name. Tool descriptions stay under 400 characters.

## Gotchas
- **Behaviour recording (macOS)**: Seatbelt only matches verified name-regex shapes (`guard/src/behaviour.ts`), needs real paths, and reports only through `log stream` run under `script` (a pipe block-buffers). Always keep the `(allow process-exec* (with report))` clause, take `watcher.position()` before spawn, and let a marker barrier flush before reading. Allow rules need a `reason`; `deletes` is a file matcher.
- **Memory/skills (ADR 0011)**: facts are shown to models, so never store a credential (refused), cap trust by writer (Markdown files and agents are never `asserted` unless the user said it), and keep the core block free of clocks. A skill is added disabled, is never executed, and refuses to load if its checksum changed. Memory tests that call tools use `freshHome()`; skills need the registry under `SIEVE_HOME/skills`.
- **Guard defaults to enforce** (the balanced preset blocks; `sieve guard mode monitor --reason …` only logs) and repo rule files can never loosen the user's policy. A rule or preset change needs tests in the rule itself (`[[rule.test]]`); `sieve guard test` must stay green. Any new tool input shape an adapter delivers (string vs object) must reach Guard as an object: an unreadable input is allowed, not refused.
- Seatbelt matches **real paths** only (macOS `/tmp` is `/private/tmp`): resolve every path put in a profile (`realish`). Sandbox tests try to escape on the real backend and skip, saying so, where there is none.
- Test source must not contain contiguous secret-shaped strings (they trip secret scanners and Sieve's own masking): build them from pieces, as `core/test/secrets.test.ts` does. A mask change needs the false-positive sweep (fixtures, this repo, the lockfile) to stay at zero hits.
- Unix socket paths are limited to ~104 bytes on macOS: tests use `mkdtemp("/tmp/sv-")`, not `os.tmpdir()`.
- Tests that host the daemon in-process must spawn subprocesses with async `Bun.spawn`, never `spawnSync` (it blocks the daemon's event loop and every hook times out).
- `SIEVE_HOME` relocates all state; `SIEVE_BIN` tells the shim which binary to start; `SIEVE_HOOK_TIMEOUT_MS` (default 250) and `SIEVE_IDLE_MINUTES` (default 30, 0 = never).
- Never run `sieve setup` without `--dry-run` against the developer's real `~/.claude` in tests or experiments; use temp dirs (`configDir`, `stateFile` options).
- The shim avoids `encoding/json` to stay under its 3 MB budget (`shim/minijson.go`); the build fails if it grows past 3 MB.
- Extractors: add a captured fixture first (extend `packages/core/fixtures/capture.sh`, never hand-edit captured output), list its must-keep facts in `fixtures/index.ts`, then write the extractor. Hand-written fixtures go in `handwritten.py` and stay labelled. Check new fixtures for local paths, usernames and hostnames before committing. Review snapshot diffs; `--update-snapshots` only after reading them.
- Never run `npx <name>` for a tool that is not installed locally: npx downloads whatever package has that name. Call `node_modules/.bin/<tool>`.
- The live daemon serves the developer's real agent sessions from `dist/`. After rebuilding, `./dist/sieve daemon stop` so the next hook starts the new build.
- Tree-sitter never runs on the main thread: parse through `OutlineClient` (worker). Hooks may only read the symbol index. Anything O(n²) or a full diff on a hook is a bug: bound it (see `boundedDiff`) and add the case to `bun run bench latency`.
- Smart reads and reruns are keyed by session + agent context (`agent_id`) + compaction epoch. Never claim the agent "has" content outside that key.
- Scripted edits: Biome reformats code, so a text replacement written from memory can silently miss. Assert the old text exists (or use the Edit tool), and re-run the tests.
- Write ADRs in `docs/adr/` for decisions with trade-offs; update PLAN.md status and deviations when a slice changes.
- For any critical decision, call advisor on Fable 5.2
