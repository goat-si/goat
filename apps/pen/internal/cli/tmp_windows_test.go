package cli

import (
	"os"
	"strconv"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func tmpRoot() string { return os.TempDir() }

// setHome points os.UserHomeDir at home (USERPROFILE on Windows).
func setHome(t *testing.T, home string) {
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)
}

// parentPID is pid's parent process id, "" when pid is gone.
func parentPID(pid int) string {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(snap)
	e := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		if int(e.ProcessID) == pid {
			return strconv.Itoa(int(e.ParentProcessID))
		}
	}
	return ""
}

// running reports whether pid is a live process.
func running(pid int) bool {
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	ev, err := windows.WaitForSingleObject(h, 0)
	return err == nil && ev == uint32(windows.WAIT_TIMEOUT)
}
