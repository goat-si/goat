//go:build unix

package state

import "os"

// Replace renames old over new.
func Replace(old, new string) error { return os.Rename(old, new) }

// transient is false: on unix a rename neither fails nor is failed by an open of the same file.
func transient(error) bool { return false }
