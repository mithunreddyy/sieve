---
description: Check Sieve's install and health (binary, daemon, hooks, MCP, isolation)
allowed-tools: Bash(sieve doctor:*), Bash(sieve status:*)
---

Run `sieve doctor` with the Bash tool, then `sieve status`.

Report only what needs attention: each `warn` or `fail` line with the fix command Sieve printed for it. If everything is `ok`, say so in one line and give the isolation line and the hook p99 as printed.

If `sieve` reports that it is not installed, tell the user to run `/sieve:install`, or `sieve-install --from <folder>` for a local build. Do not try to install it yourself.
