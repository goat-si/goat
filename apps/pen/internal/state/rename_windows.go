package state

import (
	"errors"
	"os"
	"syscall"

	"golang.org/x/sys/windows"
)

// Seam for the retry test.
var rename = os.Rename

// Replace renames old over new. While another process (a reader, an indexer, antivirus) has new open
// without FILE_SHARE_DELETE, Windows refuses the rename for a moment; Replace retries those errors for
// up to 2 s with growing waits, the rule Go's cmd/internal/robustio uses.
func Replace(old, new string) error {
	return retryTransient(func() error { return rename(old, new) }, transient)
}

// transient reports the errors a concurrent open or replace of the same file causes for a moment.
func transient(err error) bool {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return false
	}
	return errno == windows.ERROR_ACCESS_DENIED || errno == windows.ERROR_SHARING_VIOLATION
}
