# Sieve: an open-source, always-on alternative to Context Mode

Working name: **Sieve**. Check npm, GitHub, Homebrew, and the domain before you commit to it.

This file has three parts:
1. What Context Mode does, based on a close read of its docs.
2. The design decisions for Sieve, and the reason behind each.
3. The build prompt to paste into your coding agent.

---

## Part 1: What Context Mode does (from contextmode.ai/docs, November 2026)

Context Mode is two products.

**Engine: free, local, Elastic License 2.0 (source-available, not open source)**
- Runs on Node 24.15+ and uses the built-in `node:sqlite`. Windows also needs Git for Windows.
- Wires into 10 agents with each agent's own hook events. Agents fall into three groups:
  - **Standard hooks** (Claude Code, Codex, Qwen, Kiro, ZCode, Copilot CLI): `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`.
  - **Different event names** (Gemini CLI): `BeforeAgent`, `BeforeTool`, `AfterTool`, `PreCompress`. There's no session-start event.
  - **In-process plugins** (Pi, OpenCode).
- Handles large output in one of two ways, depending on the agent:
  - **Replace:** after the tool runs, output over 4 KB is indexed and the agent gets the best-matching parts.
  - **Route:** before a large call runs, the agent is told to use `ctx_execute` instead.
- Has 9 MCP tools: `ctx_execute` (16 KB output cap, 600 s timeout, background mode), `ctx_batch`, `ctx_index` (path, content, or URL, with blocking of private IP ranges), `ctx_search` (5 hits per page, scope by session, worktree, or project, timeline sort), `ctx_resume`, `ctx_stats`, `ctx_doctor` (11 checks), `ctx_upgrade`, and `ctx_purge`.
- Stores one SQLite FTS5 database per repo under `~/.context-mode/projects/<key>/`, shared by all worktrees of that repo.
  - Chunks are at most 4 KB and split by Markdown heading; code blocks are kept whole.
  - Snippets are at most 800 B.
  - Items are deleted after 30 days unread, and each project is capped at 500 MB.
- Writes a session log (prompts, edits, commands, errors, decisions) and builds a state block of at most 2 KB at compaction. Some agents get it at `SessionStart`, others with the next prompt.
- On 7 of the 10 agents, each new prompt is searched against the log and up to 2 KB of matching rows is added. Pi and OpenCode don't get this, and Kiro has to call `ctx_resume` itself.
- **No daemon.** Each hook is a fresh Node process, at 7–15 ms per call. If a hook fails, the agent gets the raw result.
- The sandbox **isolates nothing**: code runs as the user with full file and network access. Deny rules are read only from Claude Code settings.

**Gateway: hosted paid proxy, $20–$100+/month, Anthropic and OpenAI only**
- **Folding:** 15 output filters, applied the first time the gateway sees each output.
  - Passing tests, install progress, and library stack frames collapse into counted lines.
  - JSON arrays keep the first 3 items and the last.
  - It only acts when the saving is at least 768 characters and 10%. Errors are never capped.
- **Archive:** every original is stored under an ID, so it can be read back exactly.
- **Request rewrites:**
  - Tool schemas over 1.5 KB are trimmed (Claude Code only).
  - Cache marks are placed without breaking existing cache prefixes.
  - Old content is archived in fixed steps once a thread passes 750K tokens.
- **Steering:** if a read-only command printed a lot last time, the first attempt is declined once and the agent is pointed to a script that prints less.
- **Memory:** stored as subject–predicate–object facts with two timelines (when something was true, and when it was recorded).
  - Facts have three trust levels (asserted, observed, inferred) and can apply at four scopes: everywhere, repo, project, or worktree.
  - A hosted Llama 70B model extracts facts. The docs admit "slot drift", where the same fact gets stored under different names.
- **Recall:** builds a rule-based index of older work, and adds up to 3 one-line pointers when a new prompt mentions known files or errors.
- **Skills:** imported from GitHub. At most one per turn is matched and loaded.
- **Session resume** across machines works for Claude Code and Codex only, and tool output isn't kept.
- **Protect:** allow/deny rules on tool calls, with no regex.
  - It reads through about 98 wrapper commands such as `sudo`, `sh -c`, and `xargs`.
  - It offers presets and an audit log with hash chaining.
  - It **checks the command, not the program**: scripts, Makefiles, and renamed binaries get past it. It has no "ask" step. It only works while traffic goes through the gateway.

**The gaps Sieve closes**
1. The licence isn't open source.
2. Memory, recall, skills, resume, and Protect all need the paid cloud, so your code context passes through their servers.
3. No daemon, so every hook pays process start-up and nothing stays warm: no file watcher, no background indexing.
4. Coverage differs by agent: Gemini has no session-start event, Pi and OpenCode get no recall, Kiro is manual, and deny rules exist only for Claude Code.
5. File reads and MCP tool results are never folded.
6. The sandbox isolates nothing, and Protect reads command text, not behaviour.
7. Token counts are estimated at about 3 bytes per token, and the benchmarks are run by the vendor with few pairs.
8. Memory drift: the same fact lands under different names.
9. Nothing alerts you when hooks silently stop firing.
10. The gateway only supports Anthropic and OpenAI.

---

## Part 2: Design decisions for Sieve

1. **A per-user daemon plus thin shims, so it runs full time without slowing hooks down.** A long-lived `sieved` process keeps SQLite, tokenizers, tree-sitter parsers, the file watcher, and the job queue warm. Agents talk to it through a tiny native hook shim (start-up under 3 ms) and a thin MCP stdio proxy. Every agent on the machine shares one brain.
2. **It starts itself and fails open.** The first shim call starts the daemon if it isn't running. Users can also set it to start at login (launchd, systemd user unit, or Windows Task Scheduler). Every hook has a time budget. If the daemon is slow or down, the agent gets the raw output and the shim records a miss. A Sieve problem never blocks the agent.
3. **One set of events, many adapters.** Every agent's hooks are mapped to one set of events: `session.start`, `prompt.submit`, `tool.before`, `tool.after`, `compact.before`, `subagent.start`, `turn.end`, `session.end`. If an agent lacks an event, the adapter makes up for it, for example by delivering the session-start state on the first prompt. Agents with in-process plugins (OpenCode, Pi) get a native TypeScript plugin with **full** coverage, not a reduced one.
4. **Cache-safe by construction.** Sieve changes an output only the first time it sees it, and the change depends only on the text, so the same input always gives the same bytes. It never rewrites anything the model has already cached, except in fixed, rare steps. This is what keeps compression from costing more in cache writes than it saves.
5. **Nothing is lost.** Every original is archived under an ID before anything is shortened, and `sieve_get` returns it exactly. Errors, failing tests, and user text are never shortened.
6. **Behaviour, not strings.** Guard checks the parsed command (reading through wrappers, as Protect does) **and** what actually happens inside a real OS sandbox. Running the same command through a script doesn't get around it.
7. **Rules first, models optional.** Folding, recall pointers, state blocks, and staleness checks are all deterministic rules. Models are opt-in, run locally or use the user's own key, and only help: fact extraction, reranking, summaries.
8. **Honest numbers.** Savings are counted with real tokenizers and checked against task success in public paired benchmarks, losses included.

---

## Part 3: The build prompt

Copy everything below the line into your coding agent.

---

You are building **Sieve**, an open-source (Apache-2.0), local-first context engine that lives inside AI coding agents and runs all the time in the background. It cuts the tokens agents spend on tool output, file reads, and repeated work without losing any information. It remembers across sessions and agents on the user's own machine, and it enforces safety rules based on what code actually does. It must beat Context Mode (contextmode.ai) on licence, privacy, coverage, safety, efficiency, and honesty of measurement.

Write all code, names, and copy from scratch. Don't copy Context Mode's code, text, or branding. Its public docs are a reference for the problem space only.

Think through each subsystem's design before you write code. Where a decision has trade-offs, write a short ADR (decision, options, reason) in `docs/adr/`.

### 0. Principles
1. **Never block the agent.** Every hook has a time budget and fails open: on error or timeout, pass the raw output through and record a miss.
2. **Nothing is lost.** Archive the original before shortening anything. Every receipt carries an ID that `sieve_get` can expand.
3. **Cache-safe.** Change content only on first sight, and make the change depend only on the input bytes. Never rewrite text the model has already cached, except in documented fixed steps.
4. **Local by default.** No account, no telemetry, no network calls unless the user turns them on. Everything works offline.
5. **Rules first.** Deterministic rules do the core work. Models are optional helpers, local or on the user's own key.
6. **Honest.** Count real tokens with real tokenizers, measure task success, publish losses as well as wins, and never claim support that CI hasn't verified.

### 1. Stack
- **Core:** TypeScript (strict) on Bun, compiled with `bun build --compile` into one `sieve` binary per platform (macOS arm64/x64, Linux x64/arm64, Windows x64). Users install no runtime.
- **Hook shim:** `sieve-hook`, a tiny static binary written in Go (under 3 MB, start-up under 3 ms). It reads the hook's JSON from stdin, forwards it to the daemon over a Unix socket (named pipe on Windows), and writes the reply to stdout. If the daemon is down, it starts it detached and passes this call through raw. It's the only non-TypeScript code apart from the sandbox helpers.
- **Monorepo:** Bun workspaces: `core` (storage, search, extractors, memory), `daemon`, `adapters/*` (one per agent), `mcp`, `sandbox`, `guard`, `proxy`, `cli`, `dashboard`, `shim` (Go), `bench`.
- **Storage:** `bun:sqlite` in WAL mode with FTS5 (porter and trigram tables). `sqlite-vec` for optional vectors. On macOS, bundle a SQLite build that allows extensions via `Database.setCustomSQLite()`.
- **Libraries:**
  - `zod` for every input, config, and policy, with JSON schemas generated from it.
  - `@modelcontextprotocol/sdk` for MCP.
  - `web-tree-sitter` with grammar `.wasm` files embedded in the binary.
  - `diff` for diff-aware reads.
  - `@parcel/watcher` for file watching.
  - `@anthropic-ai/tokenizer` and `js-tiktoken` for token counts.
  - `@huggingface/transformers` for optional local embeddings and a reranker.
  - `hono` on `Bun.serve` for the proxy and dashboard.
  - `ink` for the TUI.
  - Vite, React, and Tailwind for the embedded dashboard.
  - `smol-toml` and `gray-matter` for config and memory files.
- **Quality:** `bun test` with snapshot tests from real tool output, `tsc --noEmit`, Biome. CI on all three operating systems.

### 2. Always-on runtime (the core of this project)

**Daemon `sieved`**
- One per user. It listens on `~/.sieve/run/sieved.sock` (`\\.\pipe\sieved-<user>` on Windows), with permissions set so only the user can connect.
- It holds the open databases for every active project, warm tokenizers, tree-sitter parsers, the file watchers, and a job queue with priorities: hook work first, background work last.
- **Lifecycle:**
  - Started on demand by the shim or the MCP proxy.
  - Optional start at login: `sieve service install` writes a launchd agent, a systemd user unit, or a Windows scheduled task.
  - Idle shutdown after a configurable time (default 30 min; `0` means never).
  - Restarted automatically after a crash, with crash loops capped.
  - The shim and daemon exchange versions. After `sieve upgrade`, the daemon finishes its current work, then restarts.
- **Health:**
  - The daemon records a heartbeat for each agent and session.
  - `sieve status` shows each connected agent, when its hooks last fired, hook misses, p50/p99 latency, queue depth, and memory use.
  - If an installed agent's hooks stop firing, or its config no longer points at Sieve, `sieve status` and the dashboard say so, and Sieve sends an optional OS notification. Silent bypass is the failure this prevents.
- **Budgets:** hook replies under 10 ms at p50 and 30 ms at p99, end to end. Background jobs never get in the way of hook replies.

**Background work while the agent is running**
- **Project watcher:** keeps an outline and symbol index of the repo up to date, built incrementally with tree-sitter. Smart reads and symbol search are instant because they don't parse anything at call time.
- **Git watcher:** watches `.git/HEAD`, refs, and the index. On checkout, pull, merge, rebase, or reset, it marks earlier reads and the memory facts tied to changed files as possibly stale.
- **Staleness:** if a file the agent read earlier has changed (by the agent, the user, or git), the next receipt or recall pointer for it says "changed since you read it".
- **Precomputation:** after each `turn.end`, it builds the next compaction state block in the background, so `compact.before` replies straight away.
- **Retention:**
  - Items are removed 30 days after their last read.
  - Each project has a size cap (default 500 MB, oldest items go first).
  - Projects closed for 14 days in every agent are cleaned up, and nothing open is ever removed.
  - All of these limits can be configured.

**One set of events, many adapters**
- Events: `session.start`, `prompt.submit`, `tool.before`, `tool.after`, `compact.before`, `subagent.start`, `turn.end`, `session.end`.
- Each adapter maps the agent's own hook names and its JSON input and output to these events, and declares what the agent supports:
  - whether it can *replace* a tool result or only *route* the call elsewhere;
  - whether it can add context at session start, on a prompt, or at compaction;
  - whether it can deny a call or ask the user.
- **Making up for missing events:**
  - No `session.start`: deliver the state block with the first `prompt.submit`.
  - No `compact.before`: rebuild the state at the next `session.start` from the session log.
  - No hook system: the MCP tools plus a generated instruction snippet that tells the agent to call `sieve_resume` first.
  - In-process plugins (OpenCode, Pi): full support, including recall pointers.
- **Agents for v1:**
  - Claude Code (plugin package plus marketplace)
  - Codex CLI
  - Gemini CLI (extension)
  - Qwen Code
  - Copilot CLI
  - VS Code Copilot
  - Cursor
  - Windsurf
  - Cline/Roo
  - Kiro
  - Zed
  - OpenCode (in-process)
  - Pi (in-process)
  - Aider and Goose (MCP plus instructions)
- **Setup** with `sieve setup --agents <list|all|detect>`:
  - Detects the installed agents and shows a plan before writing anything.
  - Backs up each file it touches to `~/.sieve/backups/`.
  - Writes only Sieve's own entries and marks hooks as trusted where the agent requires that.
  - Never edits `CLAUDE.md`, `AGENTS.md`, or other instruction files without asking.
  - Running it twice changes nothing the second time. If its own check fails, it rolls back that agent.
  - `sieve setup --remove` restores the backups.
- **Support matrix:** a real-agent end-to-end run in CI for each adapter, published as the support matrix. Adapters that haven't been verified are labelled "preview".

### 3. Capture, fold, and archive
- **Thresholds:**
  - Output under 1 KB passes through untouched.
  - A fold is kept only if it saves at least 768 characters **and** at least 10%.
  - Error output and failing tests are never cut, only cleaned (ANSI codes and progress redraws removed).
- **Replace strategy** (agents that can rewrite tool results): output over 4 KB is archived and the agent gets a **receipt**, which contains:
  - the ID;
  - the original size in real tokens;
  - the result of the extractor that ran;
  - the top lines matching the agent's stated intent;
  - a note naming what was dropped and how to fetch it;
  - "do not re-run".
- **Route strategy** (agents that can't): `tool.before` steers large-output commands to `sieve_run` instead.
- **Steering:** keep the output-size history of each command family per project. If a read-only command printed a lot last time and the expected saving is more than twice the cost of one extra model call, decline it **once** with a short reason and an equivalent `sieve_run` that prints only what's needed. The same call sent again goes through. Steering can be turned off.
- **Extractors:** format-aware, deterministic, with snapshot tests from real output.
  - **Test runners** (jest, vitest, pytest, go test, cargo test, rspec, JUnit XML, playwright): counts, then every failure kept verbatim with its assertion and project stack frames. Runs of two or more library frames collapse into one counted line.
  - **Compilers and linters** (tsc, eslint, biome, rustc/cargo/clippy, gcc/clang, mypy, ruff): errors grouped by file, duplicates counted.
  - **Package managers:** errors, warnings, and version changes. Progress output becomes one counted line.
  - **Git:** diff hunks kept whole. Log and status grouped and counted.
  - **Logs:** Drain-style template clustering ("1,240× `connection reset from <ip>`") with the first and last example of each cluster.
  - **JSON:** keep every key. Arrays over 20 items keep the first 3 and the last, with a count. Also give a shape summary.
  - **HTML:** readable Markdown.
  - **Fallback:** first 6 KB plus last 2 KB, cut at whole lines.
- **Also fold what Context Mode doesn't:**
  - **MCP tool results:** pick the extractor by content type.
  - **File reads:**
    - Files over 16 KB return an outline (symbols with line ranges, from the watcher's index) plus the ranges that match the intent.
    - A full read is still allowed, and the receipt states its token cost.
    - A re-read returns "unchanged since read #N" or only the changed hunks.
- **Diff-aware reruns:** a rerun of the same command returns a diff against the previous run ("2 now pass, 1 new failure: …").
- **Duplicate suppression** within a session.
- **Secret masking** before anything is stored: known key patterns, entropy checks, `.env` values, and private keys become `<secret:aws_key#3>`. Raw secrets never reach the database.

### 4. Search and retrieval
- **Chunking:** chunks of at most 4 KB, split by Markdown heading (the heading path is the title) and by function and class (via tree-sitter). A code block that fits in a chunk stays whole.
- **Index:** FTS5 porter table (words) plus trigram table (partial names, so `authMid` finds `authMiddleware.ts`) plus optional vectors.
- **Ranking:**
  - Fuse the results by reciprocal rank (k=60), then boost by recency (14-day half-life) and by the current session.
  - A word with zero matches gets a spelling fix from the index vocabulary.
  - An optional local reranker can reorder the top 20.
- **Results:** 5 per page. Snippets are at most 800 B, or a whole code block up to 2 KB. Each hit has its source, chunk number, and staleness flag, and a "more" cursor fetches the next page. `sort: timeline` lists hits oldest first.
- **Scopes:** session, worktree, project, or all projects. Worktrees of one repo share a database but stay separable by worktree.
- **`sieve_index`:** takes a path (respects every nested `.gitignore`), raw content, or a URL. URL fetching blocks private and link-local addresses, resolves each host and connects to the address it checked, and re-checks at every redirect (5 hops at most).

### 5. Sessions, compaction, and recall (all local)
- **Session log:** one row per step (prompt, edit, command, error, decision, index call), each with a sequence number, written by the daemon.
- **State block:** at most 2 KB, built by rules, precomputed in the background. It contains:
  - the current goal and the last request;
  - settled decisions;
  - files changed;
  - open errors and failing tests;
  - next steps;
  - search terms.
  Lines are never split; a long row becomes a `sieve_resume(seq)` pointer. It's delivered at `session.start` or the first prompt, depending on the adapter.
- **Recall pointers:** on `prompt.submit`, match the prompt against the archive by file names, symbols, and error text. Add at most 3 one-line pointers (item, age, ID, stale flag) within a 2 KB budget. These are pointers, not content, so the agent decides whether to fetch.
- **Decisions:** when the user answers a question the agent asked, or approves an action, record it as a decision for the worktree. A newer decision on the same topic replaces the older one.
- **Resume across machines** without a cloud service:
  - `sieve session export <id>` writes an encrypted bundle.
  - `sieve session import` writes the session into the agent's own format (Claude Code JSONL, Codex rollout) and prints the resume command.
  - Optional sync to a folder or bucket the user owns (S3, R2, a Syncthing folder) with end-to-end encryption.
  - Tool output is kept by ID, so resumed sessions can still expand it.

### 6. Long-term memory (local, reviewable, shareable)
- **Model:** subject–predicate–object facts with two timelines: `valid_at`/`invalid_at` for when the fact was true, and `created_at`/`expired_at` for when it was recorded.
  - Trust levels: `asserted` (the user said it), `observed` (a tool returned it), `inferred` (a model extracted it).
  - Each writer has a maximum trust level. A claim of "asserted" is downgraded unless the value appears in the user's own words.
- **Fix slot drift** (a known Context Mode failure):
  - Keep a canonical predicate vocabulary with aliases.
  - Resolve each new fact against existing facts with the same subject, by alias, trigram similarity, and optional embeddings, before inserting.
  - Show possible duplicates in `sieve memory review`.
- **Supersession:** for single-value predicates, a new value closes the old one. Nothing is deleted. A restatement with no new content updates the existing row instead of adding a new one.
- **Capture:**
  - **Rules, with no model:** commits, PRs, edited files, tool errors, decisions, and explicit `sieve_remember` calls.
  - **Optional model extraction** at `turn.end` (local model, or the user's own key): at most 5 short facts per turn. Skipped for turns with no new user text, interrupted turns, and anything matching a credential pattern.
- **Scopes:** everywhere, repo, project, worktree. Categories tied to a codebase can't go wider than their project.
- **Injection:**
  - A core block of at most 8 asserted facts in a stable, cached position.
  - A relevant block of at most 5 facts on the first request, at subagent start, and after compaction.
  - Ranking: newer facts first (30-day half-life), a boost for frequently used facts, and closed or stale facts dropped.
  - The block states that the current message overrides stored facts.
- **Storage the user controls:**
  - Facts live in SQLite.
  - `sieve memory sync` mirrors them to `.sieve/memory/*.md` (frontmatter plus text), which people can read and edit, and which a team can commit.
  - Edits to the Markdown are read back in.
  - Git history serves as the audit trail.
- **Skills:**
  - Import from any git URL or local folder, pinned to a commit and checksummed, stored on disk.
  - Matching compares the prompt with each skill's name and description (BM25 plus optional embeddings), then checks whether the skill is being requested or only mentioned.
  - At most one skill loads per turn, and a line in the reply says when one loads.
  - The skill list adds one cached line per enabled skill; keep the total small and report its token cost.

### 7. Sandbox (a real boundary)
- `sieve_run(language, code, file?, intent?, timeoutMs?, background?)`:
  - Languages: shell, PowerShell, Python, JS/TS (on Sieve's built-in Bun), or any runtime on PATH.
  - Output cap: 16 KB returned. Larger output is archived, and a preview of at most 4 KB is returned with its ID.
  - Timeout: default and maximum 600 s, and the whole process tree is killed on timeout.
  - `background: true` returns a handle the agent can poll or stream.
  - `file` is passed as `SIEVE_FILE`.
  - Scripts are written to a temp folder outside the project and deleted afterwards.
- `sieve_batch(commands[], queries[])`: runs the commands in order, indexes their output, and returns only the answers to the queries.
- **Isolation by default:**
  - **macOS:** `sandbox-exec` with generated Seatbelt profiles.
  - **Linux:** `bwrap`, or a Landlock and seccomp helper (Go, static).
  - **Windows:** an AppContainer and Job Object helper (Go).
  - **Defaults:** write access only to the project folder and a temp dir, network off, environment variables limited to an allowlist (API keys removed unless the call asks for them), CPU, memory, and time limits.
  - Each call can ask for more access (`network: ["registry.npmjs.org"]`, extra paths, specific environment variables), and Guard checks the request.
  - `sieve doctor` and every receipt state the isolation level actually in force. Never imply isolation that isn't there.

### 8. Guard (safety based on what code does)
- **Where it runs:** on `tool.before` for **every** agent through its adapter, and inside the sandbox. It doesn't depend on a proxy, so it can't be bypassed by removing a base URL.
- **Command parsing:** split shell commands into program, subcommand, flags, and arguments. Read through wrappers such as `sudo`, `env`, `sh -c`, `bash -lc`, `xargs`, `find -exec`, `timeout`, `nice`, `npx`, `docker exec`, and `ssh`. Find hosts and paths in commands, one-line scripts, URLs, and MCP inputs.
- **Behaviour checks:** inside the sandbox, record the files opened, hosts contacted, and processes started, and apply the same rules to them. Scripts, Makefile targets, `package.json` scripts, and renamed binaries are covered this way.
- **Rules:** one TOML file per scope (user, repo, worktree).
  - **Rule types:** sites (host, CIDR, port), commands (program, subcommand, flags, flag values, arguments, paths, push target, force push), capabilities (`fs.read`, `fs.write`, `net.fetch`, `pkg.install`, `vcs.publish`, `vcs.rewrite`, `secret.read`, `cloud.mutate`, `agent.spawn`, `mcp.call`, …), patterns (download-and-run, environment dump), files (folder, name, extension, outside a folder; read, write, delete, permissions), MCP servers and tools.
  - **Actions:** `allow`, `deny`, `ask` (through the agent's own permission prompt where the adapter supports it, otherwise deny with an explanation), `log`.
  - **Modes:** `enforce` or `monitor` (log what would have been blocked).
  - **Tests:** every rule can carry saved tests, and `sieve guard test` runs them.
- **Presets:**
  - `observe`;
  - `balanced`: disk wipe, deleting root or home, `chmod -R 777 /`, fork bombs, production destroy commands, force push to protected branches, `.env` and credential files, `curl | sh`, and unapproved package registries;
  - `locked`: `balanced` plus network and MCP allowlists.
  - Users can also define their own production names, protected branches, and approved registries.
- **Blocked calls:** the agent gets a short reason, the rule ID, and a safer alternative.
- **Audit log:** local JSONL, hash-chained.
  - Each row records the time, decision, rule, tool, program, host, path, project, and session.
  - Command arguments and file contents are left out unless `audit.verbose = true`.
  - Rule files are written with stable key order so git diffs are clean. Changes that loosen the policy need a reason, recorded in the log.

### 9. Optional local proxy (self-hosted gateway features)
- **How it's used:** `sieve proxy` serves Anthropic, OpenAI, and Gemini compatible endpoints on localhost, and can forward to OpenRouter, Ollama, or any OpenAI-compatible URL. The user's own key goes straight to their provider.
- **Tool schemas:** trim descriptions over 1.5 KB at a sentence boundary while keeping parameters and required fields. Provide `sieve_schema(tool)` to fetch the full definition. Works for Claude Code **and** Codex.
- **Cache marks:**
  - Never remove the client's marks.
  - Add Sieve's only where a slot is free, staying within the provider's limit.
  - If the provider rejects the count, retry once without Sieve's marks.
  - Report the cache-hit rate.
- **History handling:**
  - Fold tool results in history on first sight.
  - Archive in fixed steps past a configurable threshold, with defaults set by the model's context window.
  - Never touch file edits, signed thinking blocks, or user text.
  - When the provider refuses a request as too long, read the limit from the refusal and cut at a fixed boundary.
- **Budgets:** per-session and per-day token and dollar caps, with warnings at 50/80/100% and an optional hard stop.
- **Fail open:** any proxy error sends the request through unchanged.
- **Self-hosting for teams:** Docker image, Cloudflare Worker template, systemd unit.

### 10. MCP tools (small and clearly described)
| Tool | Purpose |
|---|---|
| `sieve_run` | Run code in the sandbox and return the extracted result plus a receipt |
| `sieve_batch` | Run several commands, index their output, and answer queries over it |
| `sieve_read` | Smart file read: outline, ranges, and changes since the last read |
| `sieve_search` | Hybrid search across the session, worktree, project, or all projects |
| `sieve_get` | Expand any archived ID, in full or by range |
| `sieve_index` | Index a path, content, or URL |
| `sieve_resume` | Return the state block, or a session log row by sequence number |
| `sieve_remember` / `sieve_recall` | Write, retract, and query memory |
| `sieve_stats` | Tokens saved, cache-hit rate, budget, hook health |

- Reject unknown fields with a clear error.
- Keep each tool description under 400 characters. Measure the total schema cost and show it in `sieve doctor`.
- Expose `doctor`, `upgrade`, and `purge` (one scope per call: session, source, worktree, or project) as CLI commands, and as slash commands where the agent supports them, not as model tools.

### 11. CLI
`sieve setup | status | doctor | stats | dash | search | get | session (list|export|import) | memory (list|review|sync|edit|prune) | skills (add|list|enable|disable) | guard (check|test|log) | proxy | service (install|uninstall) | bench | purge | upgrade`

`sieve doctor` checks the following, and gives a fix command for each failure:
- binary and shim versions match;
- the daemon is reachable;
- each agent's hooks are registered **and** actually fired recently;
- MCP handshake;
- the database is intact;
- the watcher is running;
- the isolation level;
- hook latency;
- the token cost of Sieve's own schemas.

### 12. Visibility
- **Dashboard** (`sieve dash`, local only) shows:
  - tokens in versus tokens returned, by agent, tool, extractor, and session;
  - cache-hit rate;
  - dollar estimate at list price;
  - every receipt, with "why was this cut" and a "view original" button;
  - recall pointers and memory facts, with their sources;
  - Guard decisions;
  - hook health per agent.
- **Quality canary** (opt-in): for a sample of calls, also store what the agent would have seen without Sieve, so summaries can be audited.

### 13. Benchmarks (ship in the repo, run in CI)
- **Method:** paired runs of real agents (Claude Code, Codex, Gemini CLI, OpenCode) with and without Sieve, on a public set of tasks:
  - fix a failing test;
  - debug a build;
  - analyse logs;
  - refactor across files;
  - research with web pages;
  - a long session past compaction;
  - resume a session the next day.
- **Report:**
  - real-token input and output, split into cached and uncached;
  - dollar cost at list price;
  - wall time;
  - task success, with confidence intervals;
  - losses as well as wins.
- **Micro-benchmarks:** hook latency (p50/p99, cold and warm), search latency on 100k chunks, indexing in ms per MB, and daemon memory use.
- **Release gate:** no release ships if task success drops by a statistically significant amount on any suite, or if hook p99 goes above 30 ms.

### 14. Build order (vertical slices; ship each before starting the next)
1. **Runtime skeleton:**
   - daemon with start on demand, idle shutdown, version handshake, and `sieve status`;
   - Go hook shim that fails open;
   - MCP stdio proxy;
   - SQLite storage with archive IDs;
   - `sieve_run` (no isolation yet) with receipts;
   - `sieve_get` and `sieve_search`;
   - Claude Code adapter and setup with backup and rollback;
   - benchmark harness with 5 tasks and latency micro-benchmarks.
2. **Extractors v1** (test runners, compilers, linters, git, JSON) with snapshot tests and the fold thresholds.
3. **Project and git watchers, smart reads, diff-aware rereads and reruns, staleness flags.**
4. **Session log, background state block, recall pointers, decisions.**
5. **Adapters:** Codex, Gemini CLI, Copilot CLI, Cursor, and OpenCode (in-process), with event gap handling and the CI-verified support matrix.
6. **Sandbox isolation** on macOS and Linux, then Windows. Secret masking. Isolation reporting.
7. **Guard:** parser, behaviour checks, presets, ask and monitor modes, hash-chained audit log.
8. **Memory:** facts with two timelines, slot-drift fixes, Markdown sync, skills.
9. **Steering**, the TUI, and the dashboard.
10. **Local proxy:** schema trimming, cache marks, history handling, budgets.
11. **Session export and import across machines**, optional encrypted sync, login service install.
12. **Remaining adapters**, local embeddings and reranker, public benchmark report, v1.0.

### 15. Definition of done for v1.0
- Apache-2.0, with CONTRIBUTING, a code of conduct, SECURITY.md, and a threat model for the daemon socket, sandbox, and Guard.
- One-command install on macOS, Linux, and Windows, with no runtime required. `sieve setup --agents detect` wires every installed agent and `sieve status` shows them all live.
- Hook p50 under 10 ms and p99 under 30 ms warm. A fault-injection test shows that a killed or hung daemon never breaks an agent session.
- Every archived byte can be retrieved by ID.
- Zero network calls in default mode, verified by a CI test with networking off.
- On the public benchmark: at least 50% fewer uncached input tokens on long sessions, with **no statistically significant drop in task success**. Full results published, including the tasks where Sieve didn't help.

### First deliverable (before any code)
Produce, then stop for my review:
1. An architecture diagram covering the agent, shim, daemon, stores, watchers, and proxy, with a module list.
2. The daemon protocol (message types, versioning, time budgets) and the shared event schema.
3. A per-agent table of hook names mapped to the shared events and each agent's capabilities.
4. The SQLite schema (archive, chunks, FTS tables, session log, memory facts, Guard audit).
5. The MCP tool JSON schemas.
6. The `Extractor` interface, with examples for one test runner and one linter.
7. The Guard rule grammar, with three example rules and their saved tests.
8. ADRs for the shim language, daemon start-up, and cache-safety rules.

Then build slice 1.
