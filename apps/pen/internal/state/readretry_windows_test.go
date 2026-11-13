package state

import (
	"errors"
	"os"
	"sync"
	"testing"
	"time"
	"unsafe"

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

// Real handles on the hosted Windows runner (measured with a probe): a handle with write access and no sharing makes
// Go's open fail with ERROR_SHARING_VIOLATION, and a target that a replace marked for deletion makes it fail with
// ERROR_ACCESS_DENIED. A handle with read access only and no sharing does not refuse Go's open there, so these tests
// hold the file the two ways that do.

// holdFile opens path with access and share and returns the handle and its close, which runs once.
func holdFile(t *testing.T, path string, access, share uint32) (windows.Handle, func()) {
	t.Helper()
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(p, access, share, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	var once sync.Once
	release := func() { once.Do(func() { windows.CloseHandle(h) }) }
	t.Cleanup(release)
	return h, release
}

// A writer that holds the file with no sharing refuses the read with a sharing violation; once it closes,
// ReadJSON reads the file.
func TestReadJSONReadsAFileOnceAWriterHoldingItWithoutSharingCloses(t *testing.T) {
	st, err := OpenDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := st.WriteAtomic("config.json", []byte(`{"name":"n"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, release := holdFile(t, st.Path("config.json"), windows.GENERIC_READ|windows.GENERIC_WRITE, 0)
	var refused error
	waits, _ := stubWindowsRead(t, func(name string) ([]byte, error) {
		b, err := os.ReadFile(name)
		if err != nil && refused == nil {
			refused = err
			release()
		}
		return b, err
	})
	var c Config
	if ok, err := st.ReadJSON("config.json", &c); err != nil || !ok || c.Name != "n" {
		t.Fatalf("ReadJSON = %v, %v, %+v; want the file read once the writer closed", ok, err, c)
	}
	if !errors.Is(refused, windows.ERROR_SHARING_VIOLATION) || len(*waits) == 0 {
		t.Fatalf("the first read returned %v after %d waits; want a sharing violation and a retry", refused, len(*waits))
	}
}

// A target marked for deletion, as a replace leaves it while the new file takes its name, denies a read. This
// simulates that: the file is marked delete-pending, and once the read was denied its last handle closes and a new
// file is created at the path; ReadJSON then reads the new one.
func TestReadJSONReadsTheNewFileOnceAReplacedTargetIsGone(t *testing.T) {
	st, err := OpenDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := st.WriteAtomic("config.json", []byte(`{"name":"old"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	// No other process (an indexer, antivirus) may hold the file, or closing our handle would not remove it: an
	// exclusive open fails while another handle with read, write or delete access is open (a handle that reads only
	// attributes is not seen).
	_, onlyOne := holdFile(t, st.Path("config.json"), windows.GENERIC_READ|windows.DELETE, 0)
	onlyOne()
	h, release := holdFile(t, st.Path("config.json"), windows.DELETE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE)
	del := byte(1)
	if err := windows.SetFileInformationByHandle(h, windows.FileDispositionInfo, &del, uint32(unsafe.Sizeof(del))); err != nil {
		t.Fatal(err)
	}
	var refused error
	waits, _ := stubWindowsRead(t, func(name string) ([]byte, error) {
		b, err := os.ReadFile(name)
		if err != nil && refused == nil {
			refused = err
			release() // the old file goes with its last handle
			if werr := os.WriteFile(name, []byte(`{"name":"new"}`), 0o600); werr != nil {
				t.Errorf("writing the new file: %v", werr)
			}
		}
		return b, err
	})
	var c Config
	if ok, err := st.ReadJSON("config.json", &c); err != nil || !ok || c.Name != "new" {
		t.Fatalf("ReadJSON = %v, %v, %+v; want the new file read once the old one was gone", ok, err, c)
	}
	if !errors.Is(refused, windows.ERROR_ACCESS_DENIED) || len(*waits) == 0 {
		t.Fatalf("the first read returned %v after %d waits; want access denied and a retry", refused, len(*waits))
	}
}
