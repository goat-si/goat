package state

import (
	"errors"
	"math/rand/v2"
	"os"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

// Seams for the retry test.
var (
	rename      = os.Rename
	retryWait   = time.Sleep
	retryBudget = 2 * time.Second
)

// Replace renames old over new. While another process (a reader, an indexer, antivirus) has new open
// without FILE_SHARE_DELETE, Windows refuses the rename for a moment; Replace retries those errors for
// up to 2 s with growing waits, the rule Go's cmd/internal/robustio uses.
func Replace(old, new string) error {
	var waited time.Duration
	next := time.Millisecond
	for {
		err := rename(old, new)
		if err == nil || !transient(err) || waited+next > retryBudget {
			return err
		}
		retryWait(next)
		waited += next
		next += time.Duration(rand.Int64N(int64(next)))
	}
}

func transient(err error) bool {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return false
	}
	return errno == windows.ERROR_ACCESS_DENIED || errno == windows.ERROR_SHARING_VIOLATION
}
