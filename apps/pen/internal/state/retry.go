package state

import (
	"errors"
	"io/fs"
	"math/rand/v2"
	"os"
	"time"
)

// Seams for the retry tests.
var (
	readFileOnce  = os.ReadFile
	readTransient = transient
	retryWait     = time.Sleep
	retryBudget   = 2 * time.Second
)

// retryTransient runs op until it succeeds or fails with an error isTransient rejects, waiting more
// each time, until the waits would pass retryBudget (time spent in op is not counted).
func retryTransient(op func() error, isTransient func(error) bool) error {
	var waited time.Duration
	next := time.Millisecond
	for {
		err := op()
		if err == nil || !isTransient(err) || waited+next > retryBudget {
			return err
		}
		retryWait(next)
		waited += next
		next += time.Duration(rand.Int64N(int64(next)))
	}
}

// readFile reads a state file without the state lock. On Windows an open that meets a Replace of the
// same file can fail for a moment (transient); readFile retries those by Replace's rule. A missing
// file is never retried, and on unix nothing is transient, so it reads once.
func readFile(path string) ([]byte, error) {
	var b []byte
	err := retryTransient(func() error {
		var err error
		b, err = readFileOnce(path)
		return err
	}, func(err error) bool { return !errors.Is(err, fs.ErrNotExist) && readTransient(err) })
	return b, err
}
