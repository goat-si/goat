//go:build unix

package cli

import (
	"os/exec"
	"strconv"
	"strings"
	"testing"
)

// tmpRoot is a short temp root: $TMPDIR on macOS is too long for a control socket path.
func tmpRoot() string { return "/tmp" }

// setHome points os.UserHomeDir at home.
func setHome(t *testing.T, home string) { t.Setenv("HOME", home) }

// parentPID is pid's parent process id, "" when pid is gone.
func parentPID(pid int) string {
	out, _ := exec.Command("ps", "-o", "ppid=", "-p", strconv.Itoa(pid)).Output()
	return strings.TrimSpace(string(out))
}

// running reports whether pid is a live process (a zombie is not).
func running(pid int) bool {
	out, _ := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
	st := strings.TrimSpace(string(out))
	return st != "" && !strings.HasPrefix(st, "Z")
}
