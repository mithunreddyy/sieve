package main

import (
	"bufio"
	"bytes"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func setup(t *testing.T) (home string) {
	t.Helper()
	// Short path: Unix socket paths are limited to ~104 bytes on macOS.
	home, err := os.MkdirTemp("/tmp", "shm")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	t.Setenv("SIEVE_HOME", home)
	t.Setenv("SIEVE_BIN", filepath.Join(home, "no-such-binary"))
	t.Setenv("SIEVE_HOOK_TIMEOUT_MS", "150")
	_ = os.MkdirAll(filepath.Join(home, "run"), 0o700)
	return home
}

func misses(t *testing.T, home string) string {
	b, _ := os.ReadFile(filepath.Join(home, "run", "misses.log"))
	return string(b)
}

// fakeDaemon accepts connections and answers each frame with reply(frame).
func fakeDaemon(t *testing.T, home string, reply func(frame string) string) {
	t.Helper()
	ln, err := net.Listen("unix", filepath.Join(home, "run", "sieved.sock"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				line, err := bufio.NewReader(c).ReadString('\n')
				if err != nil {
					return
				}
				if r := reply(line); r != "" {
					c.Write([]byte(r))
				} else {
					time.Sleep(2 * time.Second) // hung daemon
				}
			}(c)
		}
	}()
}

func TestDaemonDownPassesThrough(t *testing.T) {
	home := setup(t)
	var out bytes.Buffer
	code := run([]string{"claude-code", "PostToolUse"}, strings.NewReader(`{"a":1}`), &out)
	if code != 0 || out.Len() != 0 {
		t.Fatalf("want pass-through, got code=%d out=%q", code, out.String())
	}
	if !strings.Contains(misses(t, home), "\tdaemon-down") {
		t.Fatalf("miss not recorded: %q", misses(t, home))
	}
}

func TestHungDaemonTimesOut(t *testing.T) {
	home := setup(t)
	fakeDaemon(t, home, func(string) string { return "" })
	start := time.Now()
	var out bytes.Buffer
	code := run([]string{"claude-code", "PostToolUse"}, strings.NewReader(`{"a":1}`), &out)
	if el := time.Since(start); el > 500*time.Millisecond {
		t.Fatalf("shim blocked for %v", el)
	}
	if code != 0 || out.Len() != 0 || !strings.Contains(misses(t, home), "\ttimeout") {
		t.Fatalf("want timeout pass-through, got code=%d out=%q misses=%q", code, out.String(), misses(t, home))
	}
}

func TestReplyIsPrintedAndInputFlattened(t *testing.T) {
	home := setup(t)
	var got string
	fakeDaemon(t, home, func(frame string) string {
		got = frame
		return `{"v":1,"id":"h","ok":true,"daemon":"0.1.0","result":{"stdout":"{\"x\":\"a\\nb é 😀\"}","exitCode":0}}` + "\n"
	})
	var out bytes.Buffer
	code := run([]string{"claude-code", "PostToolUse"}, strings.NewReader("{\n  \"tool_name\": \"Bash\"\n}\n"), &out)
	if code != 0 || out.String() != "{\"x\":\"a\\nb é 😀\"}" {
		t.Fatalf("code=%d out=%q", code, out.String())
	}
	if strings.Count(got, "\n") != 1 || !strings.Contains(got, `"agent":"claude-code"`) || !strings.Contains(got, `"tool_name": "Bash"`) {
		t.Fatalf("bad frame: %q", got)
	}
}

func TestErrorReplyIsAMiss(t *testing.T) {
	home := setup(t)
	fakeDaemon(t, home, func(string) string {
		return `{"v":1,"ok":false,"daemon":"9.0.0","error":{"code":"version_mismatch","message":"x"}}` + "\n"
	})
	var out bytes.Buffer
	if code := run(nil, strings.NewReader(`{}`), &out); code != 0 || out.Len() != 0 {
		t.Fatal("error reply must pass through")
	}
	if !strings.Contains(misses(t, home), "version_mismatch") {
		t.Fatalf("misses=%q", misses(t, home))
	}
}

func TestGarbageReplyAndInput(t *testing.T) {
	home := setup(t)
	fakeDaemon(t, home, func(string) string { return "not json\n" })
	var out bytes.Buffer
	if run(nil, strings.NewReader(`{}`), &out) != 0 || out.Len() != 0 {
		t.Fatal("garbage reply must pass through")
	}
	if run(nil, strings.NewReader(`hello`), &out) != 0 || out.Len() != 0 {
		t.Fatal("garbage input must pass through")
	}
	m := misses(t, home)
	if !strings.Contains(m, "bad-reply") || !strings.Contains(m, "bad-input") {
		t.Fatalf("misses=%q", m)
	}
}

func TestCrashLoopCap(t *testing.T) {
	home := setup(t)
	f := filepath.Join(home, "run", "spawns")
	for i := 0; i < spawnMax; i++ {
		if spawnedTooOften(f) {
			t.Fatalf("capped too early at %d", i)
		}
	}
	if !spawnedTooOften(f) {
		t.Fatal("cap not applied")
	}
}

func TestMiniJSON(t *testing.T) {
	v, err := parseJSON(`{"a":[1,2.5,-3e2,true,false,null],"b":{"c":"x\"y\\z\/\t"},"d":"é😀"}`)
	if err != nil {
		t.Fatal(err)
	}
	m := v.(map[string]any)
	if m["b"].(map[string]any)["c"] != "x\"y\\z/\t" || m["d"] != "é😀" || len(m["a"].([]any)) != 6 {
		t.Fatalf("%#v", m)
	}
	for _, bad := range []string{`{`, `{"a"}`, `[1,]`, `"\x"`, `{"a":1}x`} {
		if _, err := parseJSON(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	if jsonString("a\"b\\\n\x01é") != `"a\"b\\\n\u0001é"` {
		t.Fatal(jsonString("a\"b\\\n\x01é"))
	}
}

// Installed both ways (the Claude Code plugin and `sieve setup`'s settings.json hooks), two hooks
// would answer every event; for smart reads one could report "unchanged" for content the agent
// never got. Exactly one route acts: the plugin's call defers to the settings.json hooks.
func TestPluginRouteDefersToSetupHooks(t *testing.T) {
	home := setup(t)
	cfg := filepath.Join(home, "claude")
	_ = os.MkdirAll(cfg, 0o700)
	t.Setenv("CLAUDE_CONFIG_DIR", cfg)
	t.Setenv("SIEVE_ROUTE", "plugin")
	asked := 0
	fakeDaemon(t, home, func(string) string {
		asked++
		return `{"v":1,"id":"h","ok":true,"daemon":"0.1.0","result":{"stdout":"RECEIPT","exitCode":0}}` + "\n"
	})
	in := `{"tool_name":"Bash"}`

	// no settings.json hooks: the plugin route acts
	var out bytes.Buffer
	if code := run([]string{"claude-code", "PostToolUse"}, strings.NewReader(in), &out); code != 0 || out.String() != "RECEIPT" {
		t.Fatalf("plugin alone: code=%d out=%q", code, out.String())
	}

	// settings.json also runs sieve-hook for claude-code: the plugin route stays silent, and it is not a miss
	settings := `{"hooks":{"PostToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"\"/x/sieve-hook\" claude-code PostToolUse"}]}]}}`
	_ = os.WriteFile(filepath.Join(cfg, "settings.json"), []byte(settings), 0o600)
	out.Reset()
	before := asked
	if code := run([]string{"claude-code", "PostToolUse"}, strings.NewReader(in), &out); code != 0 || out.String() != "" {
		t.Fatalf("both routes: code=%d out=%q", code, out.String())
	}
	if asked != before || misses(t, home) != "" {
		t.Fatalf("deferred call reached the daemon (%d) or logged a miss: %q", asked-before, misses(t, home))
	}

	// the settings route itself (no SIEVE_ROUTE) still acts
	t.Setenv("SIEVE_ROUTE", "")
	out.Reset()
	if code := run([]string{"claude-code", "PostToolUse"}, strings.NewReader(in), &out); code != 0 || out.String() != "RECEIPT" {
		t.Fatalf("settings route: code=%d out=%q", code, out.String())
	}
}

// A cold daemon misses the first hooks of a session (found: every fresh benchmark run lost its
// SessionStart and first UserPromptSubmit), so the shim keeps what it could not deliver for the
// daemon to replay when it starts. Small frames only, and a bounded number of them.
func TestDaemonDownSpoolsTheFrame(t *testing.T) {
	home := setup(t)
	var out bytes.Buffer
	in := `{"session_id":"s1","hook_event_name":"UserPromptSubmit","prompt":"find user 137"}`
	if code := run([]string{"claude-code", "UserPromptSubmit"}, strings.NewReader(in), &out); code != 0 || out.Len() != 0 {
		t.Fatalf("daemon down must pass through: code=%d out=%q", code, out.String())
	}
	ents, _ := os.ReadDir(filepath.Join(home, "run", "spool"))
	if len(ents) != 1 {
		t.Fatalf("want 1 spooled frame, got %d", len(ents))
	}
	b, _ := os.ReadFile(filepath.Join(home, "run", "spool", ents[0].Name()))
	if !strings.Contains(string(b), `"event":"UserPromptSubmit"`) || !strings.Contains(string(b), "find user 137") || !strings.HasSuffix(string(b), "}\n") {
		t.Fatalf("bad spooled frame: %q", b)
	}
	// a large input (a tool output) is not spooled
	big := `{"session_id":"s1","hook_event_name":"PostToolUse","tool_response":{"stdout":"` + strings.Repeat("x", 70<<10) + `"}}`
	run([]string{"claude-code", "PostToolUse"}, strings.NewReader(big), &out)
	if ents, _ := os.ReadDir(filepath.Join(home, "run", "spool")); len(ents) != 1 {
		t.Fatalf("a large frame was spooled: %d files", len(ents))
	}
	// and the spool is bounded
	for i := 0; i < 40; i++ {
		run([]string{"claude-code", "UserPromptSubmit"}, strings.NewReader(in), &out)
	}
	if ents, _ := os.ReadDir(filepath.Join(home, "run", "spool")); len(ents) > 32 {
		t.Fatalf("spool not bounded: %d files", len(ents))
	}
}
