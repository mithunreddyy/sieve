package main

import (
	"errors"
	"path/filepath"
)

// policy is what the caller asked for.
type policy struct {
	ro, rw []string
	noNet  bool
	cmd    []string
}

// parseArgs reads: [--ro PATH]... [--rw PATH]... [--no-net] -- COMMAND [ARGS...]
// Paths must be absolute; nothing is guessed.
func parseArgs(args []string) (policy, error) {
	var p policy
	i := 0
	for ; i < len(args); i++ {
		switch args[i] {
		case "--ro", "--rw":
			if i+1 >= len(args) {
				return p, errors.New(args[i] + " needs a path")
			}
			path := args[i+1]
			if !filepath.IsAbs(path) {
				return p, errors.New("path must be absolute: " + path)
			}
			if args[i] == "--ro" {
				p.ro = append(p.ro, filepath.Clean(path))
			} else {
				p.rw = append(p.rw, filepath.Clean(path))
			}
			i++
		case "--no-net":
			p.noNet = true
		case "--":
			p.cmd = args[i+1:]
			if len(p.cmd) == 0 {
				return p, errors.New("no command after --")
			}
			return p, nil
		default:
			return p, errors.New("unknown argument: " + args[i])
		}
	}
	return p, errors.New("missing -- COMMAND")
}
