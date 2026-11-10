# Slice 1 benchmark report

Run: 2026-11-10 · Apple M4 Pro · macOS · Bun 1.4.4 · Go 1.27.3 · `bun run bench`

**What this is and is not.** These are offline measurements: synthetic tool outputs replayed through the real fold code, and hook latency measured end to end on one machine. They are **not** the paired real-agent benchmark from prompt.md §13 (task success with confidence intervals, cached vs uncached tokens, dollars). That harness needs real agents and API spend and is planned, not run. No claim of task-success parity is made from these numbers.

## Replay (5 synthetic tasks, fallback extractor only; tokens: o200k_base)

| task | tokens in | tokens seen | saved | facts kept |
|---|---:|---:|---:|---|
| fix-failing-test | 6828 | 3257 | 52% | yes |
| debug-build | 4526 | 2528 | 44% | yes |
| analyse-logs | 252002 | 4126 | 98% | yes |
| refactor-across-files | 12619 | 2681 | 79% | **no**: missing `bootstrap.ts:12:export function createLegacyClient` |
| research-web | 9607 | 1792 | 81% | yes |

A task that loses a fact is a loss for Sieve even if it saves tokens: the agent would have to call sieve_get or re-run.

## Hook latency, end to end (exec → stdout), this machine

| case | n | p50 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|
| go shim, cold (no daemon, pass-through) | 1 | 4.91 | 4.91 | 4.91 |
| go shim, warm, PreToolUse (small) | 300 | 2.04 | 2.52 | 3.33 |
| go shim, warm, PostToolUse 60 KB → receipt | 100 | 6.18 | 17.42 | 17.42 |
| ts fallback (sieve hook), warm, PreToolUse | 20 | 19.81 | 23.8 | 23.8 |

Release gate (warm go shim p99 ≤ 30 ms): pass

## Reading the results

- **Loss: `refactor-across-files`.** Search output where every line matches the intent equally ties, so the first 20 matches win and the definition on line 501 is dropped from view (it is archived and searchable, but the agent is not told it exists). Slice 2's search-results extractor (group by file, surface definitions) is meant to fix this; the task stays in the suite as a regression check.
- **`fix-failing-test` kept its facts only after a fix found by this benchmark:** the first version of the fallback fold dropped the one failing test from the middle of 420 passing ones. Error and failure lines are now lifted out of the dropped middle with two lines of context.
- **Savings on test and build output are modest (44–52%)** because slice 1 has only the generic fallback extractor. Format-aware extractors are slice 2.
- **Latency:** warm hooks are ~2 ms p50, well under the 10 ms / 30 ms budget. The 60 KB fold path (archive insert, real token count, receipt) is 6 ms p50 / 17 ms p99. The TypeScript fallback hook costs ~20 ms per call from Bun start-up alone, which is the reason for the Go shim (ADR 0001).
- `cold` is a single sample: the pass-through when no daemon is running, including the detached spawn.
