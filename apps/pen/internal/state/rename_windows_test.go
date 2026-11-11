package state

import (
	"errors"
	"os"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// stubRename replaces the rename and the wait between retries; waits are recorded, never slept.
func stubRename(t *testing.T, f func(old, new string) error) *[]time.Duration {
	t.Helper()
	oldRename, oldWait := rename, retryWait
	t.Cleanup(func() { rename, retryWait = oldRename, oldWait })
	var waits []time.Duration
	rename = f
	retryWait = func(d time.Duration) { waits = append(waits, d) }
	return &waits
}

func failWith(errno windows.Errno) error {
	return &os.LinkError{Op: "rename", Old: "a", New: "b", Err: errno}
}

func TestReplaceRetriesWhileAnotherProcessHoldsTheTarget(t *testing.T) {
	fails := 2
	waits := stubRename(t, func(_, _ string) error {
		if fails > 0 {
			fails--
			return failWith(windows.ERROR_SHARING_VIOLATION)
		}
		return nil
	})
	if err := Replace("a", "b"); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if len(*waits) != 2 {
		t.Fatalf("waited %d times, want 2", len(*waits))
	}
}

func TestReplaceGivesUpOnceItsBudgetIsSpent(t *testing.T) {
	waits := stubRename(t, func(_, _ string) error { return failWith(windows.ERROR_ACCESS_DENIED) })
	err := Replace("a", "b")
	if !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatalf("Replace: %v, want access denied", err)
	}
	var total time.Duration
	for _, w := range *waits {
		total += w
	}
	if len(*waits) == 0 || total > retryBudget {
		t.Fatalf("waited %d times for %v in all, want some waits within %v", len(*waits), total, retryBudget)
	}
}

func TestReplaceReturnsAPermanentErrorAtOnce(t *testing.T) {
	waits := stubRename(t, func(_, _ string) error { return failWith(windows.ERROR_PATH_NOT_FOUND) })
	if err := Replace("a", "b"); !errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
		t.Fatalf("Replace: %v", err)
	}
	if len(*waits) != 0 {
		t.Fatalf("waited %d times for a permanent error", len(*waits))
	}
}
