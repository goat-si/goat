//go:build unix

package state

import (
	"errors"
	"os"
	"syscall"
	"testing"
	"time"
)

// On unix a rename never fails a reader, so ReadJSON makes one attempt and returns its error, as before.
func TestReadJSONOnUnixReadsOnce(t *testing.T) {
	oldRead, oldWait := readFileOnce, retryWait
	t.Cleanup(func() { readFileOnce, retryWait = oldRead, oldWait })
	calls, waits := 0, 0
	readFileOnce = func(name string) ([]byte, error) {
		calls++
		return nil, &os.PathError{Op: "open", Path: name, Err: syscall.EACCES}
	}
	retryWait = func(time.Duration) { waits++ }
	st := &Store{Dir: t.TempDir()}
	var c Config
	if _, err := st.ReadJSON("config.json", &c); !errors.Is(err, syscall.EACCES) {
		t.Fatalf("ReadJSON: %v, want permission denied", err)
	}
	if calls != 1 || waits != 0 {
		t.Fatalf("%d reads and %d waits, want 1 and 0", calls, waits)
	}
}
