package state

import (
	"errors"
	"os"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// stubWindowsRead replaces the single read and the wait, keeping the real transient check.
func stubWindowsRead(t *testing.T, f func(name string) ([]byte, error)) (*[]time.Duration, *int) {
	t.Helper()
	oldRead, oldWait := readFileOnce, retryWait
	t.Cleanup(func() { readFileOnce, retryWait = oldRead, oldWait })
	var waits []time.Duration
	calls := 0
	readFileOnce = func(name string) ([]byte, error) {
		calls++
		return f(name)
	}
	retryWait = func(d time.Duration) { waits = append(waits, d) }
	return &waits, &calls
}

func TestReadJSONRetriesASharingViolationAndAccessDenied(t *testing.T) {
	for _, errno := range []windows.Errno{windows.ERROR_SHARING_VIOLATION, windows.ERROR_ACCESS_DENIED} {
		st := &Store{Dir: t.TempDir()}
		failed := false
		waits, calls := stubWindowsRead(t, func(name string) ([]byte, error) {
			if !failed {
				failed = true
				return nil, &os.PathError{Op: "open", Path: name, Err: errno}
			}
			return []byte(`{"name":"n"}`), nil
		})
		var c Config
		if ok, err := st.ReadJSON("config.json", &c); err != nil || !ok || c.Name != "n" {
			t.Fatalf("%v: ReadJSON = %v, %v, %+v; want the file read after one retry", errno, ok, err, c)
		}
		if *calls != 2 || len(*waits) != 1 {
			t.Fatalf("%v: %d reads and %d waits, want 2 and 1", errno, *calls, len(*waits))
		}
	}
}

func TestReadJSONReportsAMissingFileOnWindowsAtOnce(t *testing.T) {
	st := &Store{Dir: t.TempDir()}
	waits, calls := stubWindowsRead(t, func(name string) ([]byte, error) {
		return nil, &os.PathError{Op: "open", Path: name, Err: windows.ERROR_FILE_NOT_FOUND}
	})
	var c Config
	if ok, err := st.ReadJSON("config.json", &c); ok || err != nil {
		t.Fatalf("ReadJSON = %v, %v; want absent", ok, err)
	}
	if *calls != 1 || len(*waits) != 0 {
		t.Fatalf("%d reads and %d waits, want 1 and 0", *calls, len(*waits))
	}
}

// A real handle opened with no sharing makes os.ReadFile fail with ERROR_SHARING_VIOLATION, as a
// reader does when it meets a replace; once that handle closes, ReadJSON reads the file.
func TestReadJSONReadsAFileOnceAnExclusiveHandleCloses(t *testing.T) {
	st, err := OpenDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := st.WriteAtomic("config.json", []byte(`{"name":"n"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	p, err := windows.UTF16PtrFromString(st.Path("config.json"))
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	closed := false
	t.Cleanup(func() {
		if !closed {
			windows.CloseHandle(h)
		}
	})
	var refused error
	waits, _ := stubWindowsRead(t, func(name string) ([]byte, error) {
		b, err := os.ReadFile(name)
		if err != nil && refused == nil {
			refused = err
			closed = true
			windows.CloseHandle(h)
		}
		return b, err
	})
	var c Config
	if ok, err := st.ReadJSON("config.json", &c); err != nil || !ok || c.Name != "n" {
		t.Fatalf("ReadJSON = %v, %v, %+v; want the file read once the handle closed", ok, err, c)
	}
	if !errors.Is(refused, windows.ERROR_SHARING_VIOLATION) || len(*waits) == 0 {
		t.Fatalf("the first read returned %v after %d waits; want a sharing violation and a retry", refused, len(*waits))
	}
}
