# Slice 2 benchmark report

Run: 2026-11-10 · Apple M4 Pro · macOS · Bun 1.4.4 · Go 1.27.3 · `bun run bench`

**What this is and is not.** Offline measurements: tool output replayed through the real hook-path fold (receipt included), and hook latency end to end on one machine. 31 of the 35 outputs are **captured** from the real tools (`packages/core/fixtures/captured.tsv` records each command and tool version; `capture.sh` regenerates them); 4 are **hand-written** in the tools' formats because cargo, rspec and playwright are not installed on the capture machine. This is **not** the paired real-agent benchmark from prompt.md §13; no claim about task success is made from it.

A row "keeps its facts" only if every must-keep string for that output (failure messages, locations, summaries; listed in `packages/core/fixtures/index.ts`) is visible in what the agent receives.

## Replay: real tool output through the hook-path fold (receipt included; tokens: o200k_base)

Facts are checked in what the agent sees. A row that saves tokens but loses a fact is a loss.

| output | source | extractor | tokens in | tokens seen | saved | facts kept |
|---|---|---|---:|---:|---:|---|
| vitest/default-two-failures | captured | pass | 1420 | 1420 | 0% | yes |
| vitest/verbose-two-failures | captured | vitest | 4003 | 1091 | 73% | yes |
| vitest/all-pass | captured | pass | 681 | 681 | 0% | yes |
| jest/default-two-failures | captured | pass | 652 | 652 | 0% | yes |
| jest/verbose-two-failures | captured | pass | 652 | 652 | 0% | yes |
| bun-test/one-failure | captured | pass | 199 | 199 | 0% | yes |
| tsc/many-duplicates | captured | pass | 1095 | 1095 | 0% | yes |
| eslint/stylish-repeated | captured | eslint | 1454 | 1078 | 26% | yes |
| biome/lint-repeated | captured | biome | 7496 | 893 | 88% | yes |
| pytest/default-two-failures | captured | pytest | 1336 | 812 | 39% | yes |
| pytest/verbose-two-failures | captured | pytest | 4190 | 849 | 80% | yes |
| junit/pytest-two-failures | captured | junit | 4672 | 748 | 84% | yes |
| mypy/many-duplicates | captured | mypy | 1394 | 698 | 50% | yes |
| ruff/many-duplicates | captured | ruff | 7370 | 1915 | 74% | yes |
| pkg/pip-install | captured | pass | 746 | 746 | 0% | yes |
| pkg/npm-install-deprecated | captured | pass | 644 | 644 | 0% | yes |
| pkg/pnpm-add | captured | pass | 82 | 82 | 0% | yes |
| logs/npm-silly | captured | logs | 11547 | 897 | 92% | yes |
| go-test/verbose-one-failure | captured | go-test | 1752 | 172 | 90% | yes |
| go-test/default-one-failure | captured | pass | 45 | 45 | 0% | yes |
| go-test/panic | captured | pass | 371 | 371 | 0% | yes |
| clang/repeated | captured | clang | 2112 | 658 | 69% | yes |
| git/log | captured | git-log | 10675 | 3887 | 64% | yes |
| git/log-stat | captured | git-log | 10262 | 2471 | 76% | yes |
| git/diff-range | captured | git-diff | 53058 | 4625 | 91% | yes |
| git/status-many | captured | pass | 590 | 590 | 0% | yes |
| search/rg-many | captured | search | 23983 | 3858 | 84% | yes |
| search/grep-many | captured | search | 4016 | 1749 | 56% | yes |
| json/npm-view | captured | json | 46344 | 9613 | 79% | yes |
| json/github-issues | captured | json | 46371 | 5284 | 89% | yes |
| html/node-path-docs | captured | html | 34229 | 3145 | 91% | yes |
| cargo-test/one-failure | hand-written | pass | 830 | 830 | 0% | yes |
| rustc/cargo-build | hand-written | rustc | 1430 | 579 | 60% | yes |
| rspec/one-failure | hand-written | pass | 251 | 251 | 0% | yes |
| playwright/one-failure | hand-written | playwright | 1597 | 381 | 76% | yes |

Total: 287549 → 53661 tokens (81% fewer); 0 of 35 lost a fact.

## Replay: the five slice-1 synthetic tasks (for comparison across slices)

| output | extractor | tokens in | tokens seen | saved | facts kept |
|---|---|---:|---:|---:|---|
| fix-failing-test | vitest | 6828 | 235 | 97% | yes |
| debug-build | tsc | 4526 | 2473 | 45% | yes |
| analyse-logs | logs | 252002 | 245 | 100% | yes |
| refactor-across-files | search | 12619 | 6756 | 46% | yes |
| research-web | fallback | 9607 | 1792 | 81% | yes |

Total: 285582 → 11501 tokens (96% fewer); 0 of 5 lost a fact.

## Hook latency, end to end (exec → stdout), this machine

| case | n | p50 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|
| go shim, cold (no daemon, pass-through) | 1 | 5.27 | 5.27 | 5.27 |
| go shim, warm, PreToolUse (small) | 300 | 2.39 | 3.14 | 4.07 |
| go shim, warm, PostToolUse 60 KB → receipt | 100 | 8.17 | 14.4 | 14.4 |
| ts fallback (sieve hook), warm, PreToolUse | 20 | 21.64 | 22.94 | 22.94 |

Release gate (warm go shim p99 ≤ 30 ms): pass

## Reading the results

- **No output lost a fact**, including the slice-1 loss (`refactor-across-files`): the search extractor now lists definitions of the searched name first, verbatim.
- **"pass" rows are outputs under 4 KB.** They are archived and indexed but reach the agent unchanged (the replace threshold), even where an extractor would shorten them. Lowering the threshold is a cache/benefit trade-off to measure with real agents, not here.
- **Weakest savings:** eslint (26%): every one of the 60 locations is kept by design, so the saving is only the repeated message text. pytest default (39%): most of that output is the failures themselves.
- **Fixtures are small projects.** Real suites with thousands of passing tests fold far more (the synthetic slice-1 tasks show the shape of that); the captured set favours correctness over size.
- **Latency.** Extraction itself costs ~0.3 ms for 60 KB (measured in-process). The 60 KB path is dominated by the real token count and the archive insert. Two fixes found while measuring this slice: SQLite's automatic WAL checkpoint could run inside a hook's archive insert (one 115 ms outlier), so the daemon now checkpoints from its background queue; and indexing a large item now runs in steps of 8 chunks so a hook never waits behind a whole item. Small-hook numbers in this run are ~0.4 ms higher than slice 1's across the board; the machine was also running a live Sieve daemon and agent sessions during this run.
