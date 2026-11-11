//go:build linux

package main

// Landlock (file access) and seccomp (IP sockets) for the current process, then exec.
// NOT RUN: written against the kernel documentation and cross-compiled, but never executed on
// Linux by the Sieve project. Landlock needs Linux 5.13+; the helper refuses to run without it
// rather than run unconfined.

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"syscall"
	"unsafe"
)

const (
	sysLandlockCreateRuleset = 444
	sysLandlockAddRule       = 445
	sysLandlockRestrictSelf  = 446

	landlockRulePathBeneath = 1
	landlockCreateVersion   = 1 << 0

	prSetNoNewPrivs = 38
	prSetSeccomp    = 22
	seccompModeFilt = 2
)

// ABI 1 filesystem rights.
const (
	fsExecute    = 1 << 0
	fsWriteFile  = 1 << 1
	fsReadFile   = 1 << 2
	fsReadDir    = 1 << 3
	fsRemoveDir  = 1 << 4
	fsRemoveFile = 1 << 5
	fsMakeChar   = 1 << 6
	fsMakeDir    = 1 << 7
	fsMakeReg    = 1 << 8
	fsMakeSock   = 1 << 9
	fsMakeFifo   = 1 << 10
	fsMakeBlock  = 1 << 11
	fsMakeSym    = 1 << 12

	fsAll  = (1 << 13) - 1
	fsRead = fsExecute | fsReadFile | fsReadDir
)

type rulesetAttr struct{ handledAccessFS uint64 }
type pathBeneath struct {
	allowedAccess uint64
	parentFD      int32
	_             int32
}

func landlockSupported() error {
	v, _, e := syscall.Syscall(sysLandlockCreateRuleset, 0, 0, landlockCreateVersion)
	if e != 0 || int(v) < 1 {
		return fmt.Errorf("Landlock is not available on this kernel (%v)", e)
	}
	return nil
}

func restrictFS(ro, rw []string) error {
	attr := rulesetAttr{handledAccessFS: fsAll}
	fd, _, e := syscall.Syscall(sysLandlockCreateRuleset, uintptr(unsafe.Pointer(&attr)), unsafe.Sizeof(attr), 0)
	if e != 0 {
		return fmt.Errorf("landlock_create_ruleset: %v", e)
	}
	defer syscall.Close(int(fd))
	add := func(path string, access uint64) error {
		pfd, err := syscall.Open(path, 0x200000 /* O_PATH */ |syscall.O_CLOEXEC, 0)
		if err != nil {
			return fmt.Errorf("open %s: %v", path, err)
		}
		defer syscall.Close(pfd)
		rule := pathBeneath{allowedAccess: access, parentFD: int32(pfd)}
		if _, _, e := syscall.Syscall6(sysLandlockAddRule, fd, landlockRulePathBeneath, uintptr(unsafe.Pointer(&rule)), 0, 0, 0); e != 0 {
			return fmt.Errorf("landlock_add_rule %s: %v", path, e)
		}
		return nil
	}
	for _, p := range ro {
		if err := add(p, fsRead); err != nil {
			return err
		}
	}
	for _, p := range rw {
		if err := add(p, fsAll); err != nil {
			return err
		}
	}
	if _, _, e := syscall.Syscall(sysLandlockRestrictSelf, fd, 0, 0); e != 0 {
		return fmt.Errorf("landlock_restrict_self: %v", e)
	}
	return nil
}

func hostArch() (archInfo, error) {
	switch runtime.GOARCH {
	case "amd64":
		return archAMD64, nil
	case "arm64":
		return archARM64, nil
	}
	return archInfo{}, errors.New("no network filter for " + runtime.GOARCH)
}

func denyIPSockets() error {
	a, err := hostArch()
	if err != nil {
		return err
	}
	prog := socketDenyFilter(a)
	raw := encode(prog, binary.NativeEndian)
	type fprog struct {
		len    uint16
		_      [6]byte
		filter *byte
	}
	fp := fprog{len: uint16(len(prog)), filter: &raw[0]}
	if _, _, e := syscall.Syscall(syscall.SYS_PRCTL, prSetSeccomp, seccompModeFilt, uintptr(unsafe.Pointer(&fp))); e != 0 {
		return fmt.Errorf("seccomp: %v", e)
	}
	return nil
}

func run(p policy) error {
	runtime.LockOSThread() // the restrictions apply to this thread, and exec keeps them
	if err := landlockSupported(); err != nil {
		return err
	}
	if _, _, e := syscall.Syscall6(syscall.SYS_PRCTL, prSetNoNewPrivs, 1, 0, 0, 0, 0); e != 0 {
		return fmt.Errorf("no_new_privs: %v", e)
	}
	if err := restrictFS(p.ro, p.rw); err != nil {
		return err
	}
	if p.noNet {
		if err := denyIPSockets(); err != nil {
			return err
		}
	}
	bin, err := exec.LookPath(p.cmd[0])
	if err != nil {
		return err
	}
	return syscall.Exec(bin, p.cmd, os.Environ())
}
