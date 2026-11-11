---
description: Install or update Sieve's binaries (downloads the matching release and verifies its checksum)
argument-hint: "[--from <folder>] [--link] [--version x.y.z]"
allowed-tools: Bash(sieve-install:*)
disable-model-invocation: true
---

Run `sieve-install $ARGUMENTS` with the Bash tool and show the output.

This downloads the release that matches the plugin's version from GitHub and checks it against the release's SHA256SUMS before installing into `~/.sieve/bin`. With `--from <folder>` it uses a local build instead and makes no network call.

If it fails, show the error as it is and stop. Do not retry with other options. When it succeeds, tell the user that Sieve's MCP tools start once Claude Code reconnects to the server: run `/mcp` and reconnect `sieve`, or restart Claude Code. Hooks work from the next tool call. Then suggest `/sieve:doctor`.
