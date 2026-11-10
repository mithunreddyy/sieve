# ADR 0004: `sieve setup --remove` strips Sieve's entries; backups are restored only on request

**Status:** accepted · 2026-11-10

## Decision
`sieve setup --remove` deletes only the hook entries and MCP server entry Sieve wrote, leaving every other key exactly as it is. Restoring a backup wholesale is a separate, explicit command: `sieve setup --restore <backup-dir>`.

## Context
prompt.md §2 says "`sieve setup --remove` restores the backups". Backups are taken at setup time. Agent config files keep changing after that: the user adds hooks, MCP servers, permissions; Claude Code itself rewrites `~/.claude.json` on every start (startup counters, project state).

## Options
1. **Restore the backup on remove** (as written in the spec). Silently throws away every change made since setup, including Claude Code's own state.
2. **Strip Sieve's entries** (chosen), keep backups for manual restore.

## Reason
Option 1 loses user data in the common case. Sieve's entries are identifiable (`sieve-hook … claude-code` commands, the `sieve` MCP key), so removing exactly them is precise, and the result is tested to equal the pre-setup config when nothing else changed. Backups stay on disk, and setup prints the `--restore` command.

## Consequences
- Setup still rolls back automatically, from the backups, when its own post-write check fails (that is immediate, so no later edits exist yet).
