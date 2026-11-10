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
