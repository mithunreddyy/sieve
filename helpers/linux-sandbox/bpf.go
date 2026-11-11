package main

// A seccomp filter that refuses to create IP sockets, as classic BPF. Pure data: it is built and
// checked on any OS, and only installed on Linux (see sandbox_linux.go).

import "encoding/binary"

// sockFilter mirrors struct sock_filter.
type sockFilter struct {
	Code uint16
	Jt   uint8
	Jf   uint8
	K    uint32
}

const (
	bpfLD  = 0x00
	bpfW   = 0x00
	bpfABS = 0x20
	bpfJMP = 0x05
	bpfJEQ = 0x10
	bpfK   = 0x00
	bpfRET = 0x06

	seccompRetAllow = 0x7fff0000
	seccompRetKill  = 0x80000000 // SECCOMP_RET_KILL_PROCESS
	seccompRetErrno = 0x00050000 // | errno

	afInet  = 2
	afInet6 = 10
	eperm   = 1

	// offsets into struct seccomp_data
	offNr   = 0
	offArch = 4
	offArg0 = 16
)

// archInfo is what differs between CPUs: the audit architecture id and the number of socket(2).
type archInfo struct {
	audit    uint32
	nrSocket uint32
}

var (
	archAMD64 = archInfo{audit: 0xc000003e, nrSocket: 41}
	archARM64 = archInfo{audit: 0xb7 | 0xc0000000, nrSocket: 198}
)

func stmt(code uint16, k uint32) sockFilter { return sockFilter{Code: code, K: k} }
func jump(code uint16, k uint32, jt, jf uint8) sockFilter {
	return sockFilter{Code: code, Jt: jt, Jf: jf, K: k}
}

// socketDenyFilter returns a program that:
//   - kills the process if it runs under a different architecture than the filter was built for
//     (a 32-bit syscall entry could otherwise dodge the number check);
//   - answers EPERM to socket(AF_INET, ...) and socket(AF_INET6, ...);
//   - allows everything else (unix sockets and the rest of the system calls).
func socketDenyFilter(a archInfo) []sockFilter {
	return []sockFilter{
		stmt(bpfLD|bpfW|bpfABS, offArch),
		jump(bpfJMP|bpfJEQ|bpfK, a.audit, 1, 0),
		stmt(bpfRET|bpfK, seccompRetKill),
		stmt(bpfLD|bpfW|bpfABS, offNr),
		jump(bpfJMP|bpfJEQ|bpfK, a.nrSocket, 0, 5), // not socket(): jump to the final allow
		stmt(bpfLD|bpfW|bpfABS, offArg0),
		jump(bpfJMP|bpfJEQ|bpfK, afInet, 2, 0),
		jump(bpfJMP|bpfJEQ|bpfK, afInet6, 1, 0),
		stmt(bpfRET|bpfK, seccompRetAllow), // another address family
		stmt(bpfRET|bpfK, seccompRetErrno|eperm),
		stmt(bpfRET|bpfK, seccompRetAllow),
	}
}

// encode lays the program out the way the kernel reads it (native-endian sock_filter structs).
func encode(p []sockFilter, order binary.ByteOrder) []byte {
	out := make([]byte, 0, len(p)*8)
	for _, f := range p {
		b := make([]byte, 8)
		order.PutUint16(b[0:], f.Code)
		b[2], b[3] = f.Jt, f.Jf
		order.PutUint32(b[4:], f.K)
		out = append(out, b...)
	}
	return out
}
