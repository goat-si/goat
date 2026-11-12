//go:build unix

package cli

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// A cloud console's command runner (dvb exec, cloud-init) starts commands without XDG_RUNTIME_DIR,
// yet with lingering on the user's systemd runs, its bus at /run/user/<uid>/bus. pen join, pen down
// and pen leave must still reach it there.
func TestServiceFindsTheUserManagerWithoutXDGRuntimeDir(t *testing.T) {
	home, err := os.MkdirTemp(tmpRoot(), "penh")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	setHome(t, home)
	t.Setenv("PEN_HOME", "")
	runtimeDir := filepath.Join(home, "run", strconv.Itoa(os.Getuid()))
	bin := filepath.Join(home, "bin")
	for _, dir := range []string{runtimeDir, bin} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(runtimeDir, "bus"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(home, "systemctl.log")
	// Like systemctl --user, the stand-in finds the user's manager only through XDG_RUNTIME_DIR.
	fake := "#!/bin/sh\n" +
		"[ -e \"$XDG_RUNTIME_DIR/bus\" ] || { echo 'Failed to connect to bus: No medium found' >&2; exit 1; }\n" +
		"echo \"$*\" >> " + shellQuote(log) + "\n"
	if err := os.WriteFile(filepath.Join(bin, "systemctl"), []byte(fake), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("XDG_RUNTIME_DIR", "")
	os.Unsetenv("XDG_RUNTIME_DIR")
	oldOS, oldRoot := serviceOS, userRuntimeRoot
	t.Cleanup(func() { serviceOS, userRuntimeRoot = oldOS, oldRoot })
	serviceOS = "linux"
	userRuntimeRoot = filepath.Join(home, "run")

	if mode := serviceMode(false, nil); mode != "systemd" {
		t.Errorf("pen up chose service mode %q, want systemd", mode)
	}
	if err := stopService("systemd", nil); err != nil {
		t.Errorf("pen down: %v", err)
	}
	if err := removeService("systemd", nil); err != nil {
		t.Errorf("pen leave: %v", err)
	}
	got, _ := os.ReadFile(log)
	want := "--user show-environment\n--user stop pen.service\n--user disable --now pen.service\n--user daemon-reload\n"
	if string(got) != want {
		t.Errorf("systemctl ran %q, want %q", strings.Split(string(got), "\n"), strings.Split(want, "\n"))
	}
}
