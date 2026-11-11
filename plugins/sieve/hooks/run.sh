#!/bin/sh
# Claude Code plugin hook: hand the event to Sieve's Go shim. No network, never blocks the agent:
# if the binary is not installed the call passes through (empty output, exit 0) and is logged as a
# miss. SIEVE_ROUTE=plugin lets the shim stay silent when `sieve setup` hooks also answer.
home="${SIEVE_HOME:-$HOME/.sieve}"
if [ -x "$home/bin/sieve-hook" ]; then
  SIEVE_ROUTE=plugin exec "$home/bin/sieve-hook" claude-code "$1"
fi
cat >/dev/null
mkdir -p "$home/run" 2>/dev/null &&
  printf '%s000\tclaude-code\t%s\tplugin-binary-missing\n' "$(date +%s)" "$1" >>"$home/run/misses.log" 2>/dev/null
exit 0
