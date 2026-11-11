//go:build unix

package daemon

import (
	"os"
	"path/filepath"
	"testing"
)

// denyCreate makes dir refuse new files, so a save into it fails.
func denyCreate(dir string) error { return os.Chmod(dir, 0o500) }

// allowCreate undoes denyCreate.
func allowCreate(dir string) error { return os.Chmod(dir, 0o700) }

// unlistableDir is a key folder path that cannot be listed, also for root: a regular file.
func unlistableDir(t *testing.T) string {
	p := filepath.Join(t.TempDir(), "ssh")
	if err := os.WriteFile(p, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}
