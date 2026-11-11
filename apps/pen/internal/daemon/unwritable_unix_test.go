//go:build unix

package daemon

import "os"

// denyCreate makes dir refuse new files, so a save into it fails.
func denyCreate(dir string) error { return os.Chmod(dir, 0o500) }

// allowCreate undoes denyCreate.
func allowCreate(dir string) error { return os.Chmod(dir, 0o700) }
