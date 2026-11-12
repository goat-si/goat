package state

import (
	"errors"
	"path/filepath"
	"testing"
)

// Concurrent daemons are excluded by this lock on every platform (flock, LockFileEx on Windows).
func TestTryLockRefusesASecondHolderUntilTheFirstReleases(t *testing.T) {
	p := filepath.Join(t.TempDir(), "daemon.lock")
	release, err := TryLock(p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := TryLock(p); !errors.Is(err, ErrLocked) {
		t.Fatalf("second TryLock while held: %v, want ErrLocked", err)
	}
	release()
	again, err := TryLock(p)
	if err != nil {
		t.Fatalf("TryLock after release: %v", err)
	}
	again()
}
