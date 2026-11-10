# ADR 0001: Write the hook shim in Go

**Status:** accepted · 2026-11-10

## Decision

`sieve-hook` is a static Go binary. It reads the hook JSON from stdin, sends it to `sieved` over the Unix socket with a deadline, and prints the reply. If anything fails it prints nothing, exits 0, and appends a miss line.

## Context

An agent execs the hook process on every tool call. The budget is 10 ms p50 and 30 ms p99 end to end, and the shim's own start-up must stay under 3 ms. The main codebase is TypeScript on Bun.

## Options

| Option                                  | Start-up  | Size          | Notes                                                                                             |
| --------------------------------------- | --------- | ------------- | ------------------------------------------------------------------------------------------------- |
| Bun-compiled TS (`bun build --compile`) | ~15–25 ms | ~60 MB        | Same language as the rest, but start-up alone eats most of the budget.                            |
| Node script                             | 30–60 ms  | needs runtime | Ruled out: users install no runtime.                                                              |
| Rust                                    | ~1 ms     | ~1 MB         | Fastest, but a second toolchain with a steeper contributor curve for ~150 lines.                  |
| Go                                      | ~1–2 ms   | ~2–3 MB       | Static cross-compilation from one machine, standard library has sockets, JSON and process groups. |
| C                                       | <1 ms     | tiny          | Hand-written JSON and Windows named-pipe code; too easy to get wrong.                             |

## Reason

Go meets the start-up and size budgets, cross-compiles all five targets without a C toolchain, and the sandbox helpers (Landlock/seccomp, AppContainer) need a native language anyway, so Go is the one non-TS language in the repo. The shim does no parsing of the hook payload beyond `json.Valid`; all logic stays in the daemon, so the Go surface stays small.

## Consequences

- CI builds the shim with `CGO_ENABLED=0` for each target and checks size < 3 MB.
- The protocol is NDJSON so the shim needs no framing library.
