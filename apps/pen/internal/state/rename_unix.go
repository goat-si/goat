//go:build unix

package state

import "os"

// Replace renames old over new.
func Replace(old, new string) error { return os.Rename(old, new) }
