package cli

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// A cloud console's command runner (dvb exec, cloud-init) has no XDG_RUNTIME_DIR, yet with linger
// the user's systemd runs; pen must still install and remove its service there.
func TestServiceFindsTheUserManagerWithoutXDGRuntimeDir(t *testing.T) {
	_, calls := fakeSystemd(t)
	root := t.TempDir()
	dir := filepath.Join(root, strconv.Itoa(os.Getuid()))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "bus"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	old := userRuntimeRoot
	t.Cleanup(func() { userRuntimeRoot = old })
	userRuntimeRoot = root
	t.Setenv("XDG_RUNTIME_DIR", "")
	os.Unsetenv("XDG_RUNTIME_DIR")
	var seen []string
	inner := run
	run = func(name string, args ...string) error {
		seen = append(seen, os.Getenv("XDG_RUNTIME_DIR"))
		return inner(name, args...)
	}
	if mode := serviceMode(false, nil); mode != "systemd" {
		t.Fatalf("service mode %q, want systemd", mode)
	}
	if err := removeService("systemd"); err != nil {
		t.Fatal(err)
	}
	if len(*calls) == 0 || len(seen) != len(*calls) {
		t.Fatalf("systemctl calls %v, environments seen %v", *calls, seen)
	}
	for _, got := range seen {
		if got != dir {
			t.Fatalf("systemctl ran with XDG_RUNTIME_DIR %q, want %q", got, dir)
		}
	}
}
