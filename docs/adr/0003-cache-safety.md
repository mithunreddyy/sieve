# ADR 0003: Cache-safety rules for anything Sieve changes

**Status:** accepted · 2026-11-10

## Decision

1. **First sight only.** Sieve changes a piece of content only at the moment it first enters the conversation (the hook reply or tool result). It never goes back and edits content the model has already seen.
2. **Bytes in, bytes out.** The change is a pure function of the input bytes (and the call's own arguments, such as `intent`). Receipts contain no timestamps, clocks, session ids, counters, or random values. Archive ids are content-addressed: `s_` + base32(sha256(content))[:12].
3. **Stable injected blocks.** Blocks injected at session start (state block, core memory facts, skills list) have a fixed position and are rebuilt only at compaction, so the cached prefix survives the session.
4. **Fixed steps for history rewrites** (proxy, slice 10). Archiving older history happens only when the thread crosses fixed thresholds (e.g. every 25% of the model's context window), never continuously, so each rewrite invalidates the cache at most once per step.
5. **Never touched:** user text, file edits, signed thinking blocks, error output (cleaned of ANSI and redraws only).

## Options considered

- **Re-fold on every turn** with the latest extractor and intent: better compression, but each change invalidates the prompt cache from that point; cache writes cost more than the tokens saved.
- **Time-dependent receipts** ("archived 3 min ago"): useful to the model, but breaks byte stability. Ages appear only in recall pointers, which are new content on a new prompt.

## Reason

Prompt-cache reads are ~10% of the price of uncached input. A compression scheme that breaks the cache can raise cost even while lowering token counts. Determinism also makes the extractors snapshot-testable.

## Consequences

- Tests assert that folding the same input twice produces identical bytes, and that the receipt contains no clock-derived values.
- Changing an extractor changes receipts for new content only; old conversations keep the bytes they already have.

## Addendum (slice 3, 2026-11-10): outputs that depend on the reader's history
Rerun comparisons ("same output as run #2", "1 fixed, 1 new") and smart reads ("unchanged since your read #1", changed hunks) depend on what the same reader saw earlier, not only on the input bytes. They stay deterministic in (input, referenced earlier archive item) and they are still first-sight-only: Sieve never edits what was already sent. They are scoped to one session, one agent context and one compaction epoch, so they never refer to content that has left the context window.
