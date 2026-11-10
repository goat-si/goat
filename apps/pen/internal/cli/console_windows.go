package cli

import (
	"os/exec"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	kernel32              = windows.NewLazySystemDLL("kernel32.dll")
	getConsoleProcessList = kernel32.NewProc("GetConsoleProcessList")
	freeConsole           = kernel32.NewProc("FreeConsole")
)

// detachConsole closes the console window Windows opened for this process when nobody else shares it
// (Task Scheduler starting a console program), as rclone and Syncthing do with --no-console. A console
// a person started pen from has its shell attached too and stays.
func detachConsole() {
	var pids [2]uint32
	if n, _, _ := getConsoleProcessList.Call(uintptr(unsafe.Pointer(&pids[0])), uintptr(len(pids))); n == 1 {
		freeConsole.Call()
	}
}

// hideWindow starts cmd without a console window.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW, HideWindow: true}
}
