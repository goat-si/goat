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

// killChildrenWithMe puts this process in a job that kills every process in it when its last handle
// closes, which is when this process ends: a daemon the supervisor started dies with the supervisor
// (schtasks /End), even one still starting, so pen down cannot leave one behind. The handle is not
// inherited, so children do not keep the job open.
func killChildrenWithMe() error {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE},
	}
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return err
	}
	if err := windows.AssignProcessToJobObject(job, windows.CurrentProcess()); err != nil {
		windows.CloseHandle(job)
		return err
	}
	return nil // the handle stays open for this process's lifetime
}
