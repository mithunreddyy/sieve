// sieve-sandbox-linux runs a command with limited file access (Landlock) and, optionally, no IP
// networking (seccomp). It is the Linux fallback for machines without bubblewrap.
//
// STATUS: written and cross-compiled, never run on Linux. Sieve does not select it unless
// SIEVE_SANDBOX_HELPER=1 is set, and `sieve doctor` says so.
package main

import (
	"fmt"
	"os"
)

func main() {
	p, err := parseArgs(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "sieve-sandbox-linux:", err)
		os.Exit(2)
	}
	if err := runPolicy(p); err != nil {
		// never fall back to running unconfined
		fmt.Fprintln(os.Stderr, "sieve-sandbox-linux: refusing to run:", err)
		os.Exit(126)
	}
}
