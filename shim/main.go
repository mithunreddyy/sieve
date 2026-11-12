// sieve-hook is the per-call hook shim. An agent execs it for every hook event. It forwards
// the event to the long-lived daemon over a Unix socket and prints the reply.
//
// Contract (ADR 0001, 0002): never block the agent and never fail it. On any problem the
// shim prints nothing, exits 0 (the agent proceeds with the raw result), and appends one
// line to ~/.sieve/run/misses.log. If the daemon is down it starts it, detached, and still
// passes this call through.
package main

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	version         = "0.1.0"
	protocolVersion = 1
	defaultTimeout  = 250 * time.Millisecond
	maxInput        = 64 << 20
	spawnWindow     = 60 * time.Second
	spawnMax        = 5
	spawnCooldown   = 5 * time.Minute
)

func sieveHome() string {
	if h := os.Getenv("SIEVE_HOME"); h != "" {
		return h
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".sieve"
	}
	return filepath.Join(home, ".sieve")
}

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "--version" || os.Args[1] == "version") {
		fmt.Printf("sieve-hook %s protocol %d\n", version, protocolVersion)
		return
	}
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout))
}

func run(args []string, stdin io.Reader, stdout io.Writer) int {
	agent, event := "", ""
	if len(args) > 0 {
		agent = args[0]
	}
	if len(args) > 1 {
		event = args[1]
	}
	home := sieveHome()
	runDir := filepath.Join(home, "run")
	miss := func(reason string) int {
		_ = os.MkdirAll(runDir, 0o700)
		f, err := os.OpenFile(filepath.Join(runDir, "misses.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err == nil {
			fmt.Fprintf(f, "%d\t%s\t%s\t%s\n", time.Now().UnixMilli(), agent, event, reason)
			f.Close()
		}
		return 0
	}

	input, err := io.ReadAll(io.LimitReader(stdin, maxInput+1))
	if err != nil || len(input) > maxInput {
		return miss("input-too-large")
	}
	// Exactly one route acts per event. Started by the Claude Code plugin while `sieve setup`'s
	// hooks are also in settings.json, this call stays silent and those hooks answer.
	if agent == "claude-code" && os.Getenv("SIEVE_ROUTE") == "plugin" && setupHooksPresent() {
		return 0
	}
	input = bytes.TrimSpace(input)
	if len(input) == 0 || (input[0] != '{' && input[0] != '[') {
		return miss("bad-input")
	}
	// Frames are newline-delimited. In valid JSON a raw newline can only be whitespace
	// (inside strings it must be escaped), so replacing CR/LF with spaces keeps the meaning.
	// Full validation is the daemon's job; invalid input comes back as bad_request.
	for i, c := range input {
		if c == '\n' || c == '\r' {
			input[i] = ' '
		}
	}

	timeout := defaultTimeout
	if v, err := strconv.Atoi(os.Getenv("SIEVE_HOOK_TIMEOUT_MS")); err == nil && v > 0 {
		timeout = time.Duration(v) * time.Millisecond
	}
	deadline := time.Now().Add(timeout)

	// The agent's JSON is embedded as-is; the shim never parses it.
	var frame bytes.Buffer
	frame.Grow(len(input) + 160)
	fmt.Fprintf(&frame, `{"v":%d,"id":"h","type":"hook","client":"sieve-hook/%s","budgetMs":%d,"agent":%s,"event":%s,"input":`,
		protocolVersion, version, timeout.Milliseconds(), jsonString(agent), jsonString(event))
	frame.Write(input)
	frame.WriteString("}\n")

	conn, err := net.DialTimeout("unix", filepath.Join(runDir, "sieved.sock"), timeout)
	if err != nil {
		spool(runDir, frame.Bytes())
		startDaemon(home)
		return miss("daemon-down")
	}
	defer conn.Close()
	_ = conn.SetDeadline(deadline)
	if _, err := conn.Write(frame.Bytes()); err != nil {
		return miss("write-failed")
	}

	line, err := bufio.NewReaderSize(conn, 64<<10).ReadBytes('\n')
	if err != nil {
		if ne, ok := err.(net.Error); ok && ne.Timeout() {
			return miss("timeout")
		}
		return miss("read-failed")
	}
	v, err := parseJSON(string(bytes.TrimSpace(line)))
	reply, _ := v.(map[string]any)
	if err != nil || reply == nil {
		return miss("bad-reply")
	}
	if ok, _ := reply["ok"].(bool); !ok {
		code := "error"
		if e, _ := reply["error"].(map[string]any); e != nil {
			if c, _ := e["code"].(string); c != "" {
				code = c
			}
		}
		return miss(code)
	}
	result, _ := reply["result"].(map[string]any)
	out, _ := result["stdout"].(string)
	exitCode, _ := result["exitCode"].(float64)
	if out != "" {
		if _, err := io.WriteString(stdout, out); err != nil {
			return 0
		}
	}
	return int(exitCode)
}

const (
	spoolMaxBytes = 64 << 10
	spoolMaxFiles = 32
)

// spool keeps a frame the daemon could not take, for a daemon that is just starting to replay: on a
// cold start the first hooks of a session (its start and the user's first prompt) are otherwise lost.
// Small frames only (tool outputs are not kept), a bounded number of them, written then renamed so the
// daemon never reads half a file. Never blocks: any error just skips it.
func spool(runDir string, frame []byte) {
	if len(frame) > spoolMaxBytes {
		return
	}
	dir := filepath.Join(runDir, "spool")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return
	}
	if ents, err := os.ReadDir(dir); err != nil || len(ents) >= spoolMaxFiles {
		return
	}
	name := filepath.Join(dir, fmt.Sprintf("%d-%d.frame", time.Now().UnixNano(), os.Getpid()))
	if err := os.WriteFile(name+".tmp", frame, 0o600); err != nil {
		return
	}
	_ = os.Rename(name+".tmp", name)
}

// setupHooksPresent reports whether Claude Code's user settings run sieve-hook for claude-code,
// which is what `sieve setup --agents claude-code` writes. One small file read, no process.
func setupHooksPresent() bool {
	dir := os.Getenv("CLAUDE_CONFIG_DIR")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return false
		}
		dir = filepath.Join(home, ".claude")
	}
	b, err := os.ReadFile(filepath.Join(dir, "settings.json"))
	if err != nil {
		return false
	}
	return bytes.Contains(b, []byte("sieve-hook")) && bytes.Contains(b, []byte("claude-code"))
}

// sieveBinary finds the main binary: $SIEVE_BIN, then next to this shim, then PATH.
func sieveBinary() string {
	if b := os.Getenv("SIEVE_BIN"); b != "" {
		return b
	}
	name := "sieve"
	if runtime.GOOS == "windows" {
		name = "sieve.exe"
	}
	if exe, err := os.Executable(); err == nil {
		p := filepath.Join(filepath.Dir(exe), name)
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	return ""
}

// startDaemon launches the daemon detached, unless it has crash-looped recently.
func startDaemon(home string) {
	runDir := filepath.Join(home, "run")
	_ = os.MkdirAll(runDir, 0o700)
	if spawnedTooOften(filepath.Join(runDir, "spawns")) {
		return
	}
	bin := sieveBinary()
	if bin == "" {
		return
	}
	logDir := filepath.Join(home, "logs")
	_ = os.MkdirAll(logDir, 0o700)
	logf, _ := os.OpenFile(filepath.Join(logDir, "sieved.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	cmd := exec.Command(bin, "daemon", "run")
	cmd.Stdout = logf
	cmd.Stderr = logf
	detach(cmd)
	if err := cmd.Start(); err == nil {
		_ = cmd.Process.Release()
	}
	if logf != nil {
		logf.Close()
	}
}

// spawnedTooOften records this spawn and reports whether the crash-loop cap is hit:
// more than spawnMax spawns within spawnWindow pauses spawning for spawnCooldown.
func spawnedTooOften(file string) bool {
	now := time.Now()
	data, _ := os.ReadFile(file)
	var recent []time.Time
	for _, l := range strings.Split(string(data), "\n") {
		ms, err := strconv.ParseInt(strings.TrimSpace(l), 10, 64)
		if err != nil {
			continue
		}
		t := time.UnixMilli(ms)
		if now.Sub(t) < spawnCooldown {
			recent = append(recent, t)
		}
	}
	inWindow := 0
	for _, t := range recent {
		if now.Sub(t) < spawnWindow {
			inWindow++
		}
	}
	if inWindow >= spawnMax {
		return true
	}
	recent = append(recent, now)
	var out strings.Builder
	for _, t := range recent {
		fmt.Fprintf(&out, "%d\n", t.UnixMilli())
	}
	_ = os.WriteFile(file, []byte(out.String()), 0o600)
	return false
}
