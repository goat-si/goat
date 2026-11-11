package cli

import (
	"errors"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

// waitExit reports whether process pid is gone within d, waiting on its handle.
func waitExit(pid int, d time.Duration) bool {
	if pid <= 0 {
		return true
	}
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return true // no such process
	}
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	ev, err := windows.WaitForSingleObject(h, uint32(d.Milliseconds()))
	return err == nil && ev == windows.WAIT_OBJECT_0
}

// startDetachedCmd starts mk's command without a console, in a process group of its own, with ready
// inherited and its handle value in PEN_READY_FD (ExtraFiles does not exist on Windows). It leaves the
// caller's job object when the job allows it; inside an sshd session job that forbids breakaway the
// daemon still starts, but ends with the session.
func startDetachedCmd(mk func() *exec.Cmd, ready *os.File, start func(*exec.Cmd) error) error {
	h := syscall.Handle(ready.Fd())
	if err := syscall.SetHandleInformation(h, syscall.HANDLE_FLAG_INHERIT, syscall.HANDLE_FLAG_INHERIT); err != nil {
		return err
	}
	try := func(flags uint32) error {
		cmd := mk()
		cmd.Env = append(cmd.Env, "PEN_READY_FD="+strconv.FormatUint(uint64(h), 10))
		cmd.SysProcAttr = &syscall.SysProcAttr{
			CreationFlags:              flags,
			HideWindow:                 true,
			AdditionalInheritedHandles: []syscall.Handle{h},
		}
		return start(cmd)
	}
	const detached = windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP
	err := try(detached | windows.CREATE_BREAKAWAY_FROM_JOB)
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return try(detached)
	}
	return err
}
