package state

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

// Go opens files on Windows without FILE_SHARE_DELETE, so while another handle (pen ls reading
// mesh.json, an indexer) has the target open, renaming over it fails with ERROR_ACCESS_DENIED. These
// tests use real handles and the real rename; only the waits between retries are recorded.

func openReader(t *testing.T, st *Store, name string) *os.File {
	t.Helper()
	f, err := os.Open(st.Path(name))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

// A save waits for a reader that holds the target open and then replaces it whole.
func TestWriteAtomicReplacesATargetAReaderHeldOpenOnceItCloses(t *testing.T) {
	st, err := OpenDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := st.WriteAtomic("mesh.json", []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	reader := openReader(t, st, "mesh.json")
	var refused error
	waits := stubRename(t, func(old, new string) error {
		err := os.Rename(old, new)
		if err != nil && refused == nil {
			refused = err
			reader.Close()
		}
		return err
	})
	if err := st.WriteAtomic("mesh.json", []byte("new"), 0o600); err != nil {
		t.Fatalf("WriteAtomic: %v", err)
	}
	if !errors.Is(refused, windows.ERROR_ACCESS_DENIED) || len(*waits) == 0 {
		t.Fatalf("the first rename over the open file returned %v after %d waits; want access denied and a retry", refused, len(*waits))
	}
	if b, _ := os.ReadFile(st.Path("mesh.json")); string(b) != "new" {
		t.Fatalf("mesh.json = %q, want new", b)
	}
}

// A reader that keeps the target open past the retry budget fails the save: the file keeps its old
// content whole and the temporary file is gone, so the caller (holding the state lock) reports an error.
func TestWriteAtomicFailsWithoutChangingATargetAReaderKeepsOpen(t *testing.T) {
	st, err := OpenDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := st.WriteAtomic("mesh.json", []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	openReader(t, st, "mesh.json")
	stubRename(t, os.Rename)
	if err := st.WriteAtomic("mesh.json", []byte("new"), 0o600); !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatalf("WriteAtomic over a held file: %v, want access denied", err)
	}
	if b, _ := os.ReadFile(st.Path("mesh.json")); string(b) != "old" {
		t.Fatalf("mesh.json = %q, want old", b)
	}
	if left, _ := filepath.Glob(st.Path(".mesh.json.tmp*")); len(left) != 0 {
		t.Fatalf("temporary files left: %v", left)
	}
}

// Whether a contended LockFileEx waits is decided by its flags: Lock (every state.json, config.json and
// mesh.json writer) must ask it to wait, exclusively, and TryLock must not. A probe inside the call proves
// the lock is held by another handle at that moment, and the contended Lock still returns once the
// holder releases it.
func TestLockWaitsForAnotherHandleAndTryLockDoesNot(t *testing.T) {
	st, err := OpenDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	release, err := st.Lock()
	if err != nil {
		t.Fatal(err)
	}
	type call struct {
		flags     uint32
		contended bool
	}
	calls := make(chan call, 2)
	old := lockFileEx
	t.Cleanup(func() { lockFileEx = old })
	lockFileEx = func(h windows.Handle, flags, reserved, low, high uint32, ol *windows.Overlapped) error {
		probe := old(h, flags|windows.LOCKFILE_FAIL_IMMEDIATELY, reserved, low, high, new(windows.Overlapped))
		if probe == nil {
			windows.UnlockFileEx(h, 0, low, high, new(windows.Overlapped))
		}
		calls <- call{flags, errors.Is(probe, windows.ERROR_LOCK_VIOLATION)}
		return old(h, flags, reserved, low, high, ol)
	}
	if _, err := TryLock(st.Path("state.lock")); !errors.Is(err, ErrLocked) {
		t.Fatalf("TryLock while held: %v, want ErrLocked", err)
	}
	if c := <-calls; c.flags&windows.LOCKFILE_FAIL_IMMEDIATELY == 0 || !c.contended {
		t.Fatalf("TryLock called LockFileEx with flags %#x (contended %v), want fail-immediately", c.flags, c.contended)
	}
	got := make(chan error, 1)
	go func() {
		r, err := st.Lock()
		if err == nil {
			r()
		}
		got <- err
	}()
	c := <-calls
	if c.flags&windows.LOCKFILE_FAIL_IMMEDIATELY != 0 || c.flags&windows.LOCKFILE_EXCLUSIVE_LOCK == 0 || !c.contended {
		t.Fatalf("Lock called LockFileEx with flags %#x (contended %v), want an exclusive lock that waits", c.flags, c.contended)
	}
	release()
	if err := <-got; err != nil {
		t.Fatalf("the waiting Lock: %v", err)
	}
}
