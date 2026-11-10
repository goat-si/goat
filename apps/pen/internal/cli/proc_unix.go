//go:build unix

package cli

import (
	"os"
	"os/exec"
	"syscall"
	"time"
)

// waitExit reports whether process pid is gone within d (a zombie counts as gone once its parent reaps it).
func waitExit(pid int, d time.Duration) bool {
	if pid <= 0 {
		return true
	}
	deadline := time.Now().Add(d)
	for syscall.Kill(pid, 0) == nil {
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
	return true
}

// startDetachedCmd starts mk's command in a session of its own with ready as fd 3, named by PEN_READY_FD.
func startDetachedCmd(mk func() *exec.Cmd, ready *os.File, start func(*exec.Cmd) error) error {
	cmd := mk()
	cmd.Env = append(cmd.Env, "PEN_READY_FD=3")
	cmd.ExtraFiles = []*os.File{ready}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return start(cmd)
}
