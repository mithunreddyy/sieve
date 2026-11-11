package main

import (
	"encoding/binary"
	"testing"
)

// run is a tiny BPF interpreter for the instructions the filter uses, so the logic is tested
// on any OS without installing it.
func interpret(prog []sockFilter, arch, nr, arg0 uint32) uint32 {
	var acc uint32
	pc := 0
	for pc < len(prog) {
		f := prog[pc]
		switch {
		case f.Code == bpfLD|bpfW|bpfABS:
			switch f.K {
			case offArch:
				acc = arch
			case offNr:
				acc = nr
			case offArg0:
				acc = arg0
			}
			pc++
		case f.Code == bpfJMP|bpfJEQ|bpfK:
			if acc == f.K {
				pc += 1 + int(f.Jt)
			} else {
				pc += 1 + int(f.Jf)
			}
		case f.Code == bpfRET|bpfK:
			return f.K
		default:
			panic("unexpected instruction")
		}
	}
	panic("fell off the program")
}

func TestSocketDenyFilter(t *testing.T) {
	for name, a := range map[string]archInfo{"amd64": archAMD64, "arm64": archARM64} {
		p := socketDenyFilter(a)
		deny := uint32(seccompRetErrno | eperm)
		cases := []struct {
			what          string
			arch, nr, arg uint32
			want          uint32
		}{
			{"IPv4 socket", a.audit, a.nrSocket, afInet, deny},
			{"IPv6 socket", a.audit, a.nrSocket, afInet6, deny},
			{"unix socket", a.audit, a.nrSocket, 1, seccompRetAllow},
			{"netlink socket", a.audit, a.nrSocket, 16, seccompRetAllow},
			{"a different system call", a.audit, a.nrSocket + 1, afInet, seccompRetAllow},
			{"the wrong architecture", a.audit ^ 0x40000000, a.nrSocket, 1, seccompRetKill},
		}
		for _, c := range cases {
			if got := interpret(p, c.arch, c.nr, c.arg); got != c.want {
				t.Errorf("%s: %s: got %#x, want %#x", name, c.what, got, c.want)
			}
		}
	}
}

func TestEncodeLayout(t *testing.T) {
	b := encode([]sockFilter{{Code: 0x0102, Jt: 3, Jf: 4, K: 0x05060708}}, binary.LittleEndian)
	want := []byte{0x02, 0x01, 3, 4, 0x08, 0x07, 0x06, 0x05}
	if string(b) != string(want) {
		t.Fatalf("got %v, want %v", b, want)
	}
}

func TestParseArgs(t *testing.T) {
	p, err := parseArgs([]string{"--ro", "/usr/", "--rw", "/work/proj", "--no-net", "--", "sh", "-c", "echo hi"})
	if err != nil || len(p.ro) != 1 || p.ro[0] != "/usr" || p.rw[0] != "/work/proj" || !p.noNet || len(p.cmd) != 3 {
		t.Fatalf("unexpected: %+v %v", p, err)
	}
	for _, bad := range [][]string{
		{"--ro", "relative/path", "--", "x"},
		{"--ro"},
		{"--bogus", "--", "x"},
		{"--rw", "/a"},
		{"--"},
	} {
		if _, err := parseArgs(bad); err == nil {
			t.Errorf("expected an error for %v", bad)
		}
	}
}
