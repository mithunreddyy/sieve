# Contributing

Thanks for helping. Sieve is a local-first context engine for AI coding agents: a per-user daemon (`sieved`), a small Go hook shim, and an MCP proxy. Apache-2.0.

## Before you change behaviour
Read [DESIGN.md](DESIGN.md) (protocol, schema, tool schemas), [PLAN.md](PLAN.md) (what each slice ships and its honest status), and [docs/adr/](docs/adr/). Decisions with trade-offs get an ADR; a slice that changes gets its PLAN.md status updated.

## Set up
```
bun install
bun run build            # dist/sieve + dist/sieve-hook (needs Go)
bun test                 # binary.test.ts needs the build first
bun run typecheck && bun run lint
(cd shim && go vet ./... && go test ./...)
bun run bench            # replay + latency
```

## The rules the project holds itself to
1. **Never block the agent.** The hook path fails open; heavy work goes on the background queue.
2. **Nothing is lost.** Archive the original before returning anything shortened; every receipt carries an id that `sieve_get` expands exactly.
3. **Cache-safe.** Receipts are pure functions of their input: no clocks, session ids, counters or randomness.
4. **Errors are never cut.**
5. **Honest.** Never claim isolation, agent support or savings that tests have not shown. Say `none (<why>)` when it is none. Label unverified adapters "preview".
6. **Local by default.** New network calls need a user action and a line in the threat model.
7. Tool arguments are strict zod objects; tool descriptions stay under 400 characters.

## Practical notes
- Tests must not contain contiguous secret-shaped strings; build them from pieces (see `packages/core/test/secrets.test.ts`).
- Unix socket paths are limited to ~104 bytes on macOS: tests use `mkdtemp("/tmp/sv-")`.
- Tests that host the daemon in-process spawn subprocesses with async `Bun.spawn`, never `spawnSync`.
- Never run `sieve setup` without `--dry-run` against your real `~/.claude` while developing; use temp dirs.
- New extractor: add a captured fixture first (`packages/core/fixtures/capture.sh`), list its must-keep facts, then write the extractor. Do not hand-edit captured output.
- A rule or preset change needs `[[rule.test]]` cases; `sieve guard test` must stay green.
- Run the whole gate (lint, typecheck, `bun test`, Go vet/test) before opening a pull request, and say in the description what you did *not* test.

## Reporting bugs
Include `sieve version`, `sieve doctor` output, and the agent and its version. For wrong shortening, include the receipt id and run `sieve get <id>` to attach the original (after checking it for anything private).
