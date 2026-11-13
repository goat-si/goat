package state

import (
	"errors"
	"io/fs"
	"os"
	"testing"
	"time"
)

var errBusy = errors.New("busy")

// stubRead replaces the single read, the transient check (errBusy only) and the wait between
// retries; waits are recorded, never slept. It returns the waits and the number of reads.
func stubRead(t *testing.T, f func(name string) ([]byte, error)) (*[]time.Duration, *int) {
	t.Helper()
	oldRead, oldTransient, oldWait := readFileOnce, readTransient, retryWait
	t.Cleanup(func() { readFileOnce, readTransient, retryWait = oldRead, oldTransient, oldWait })
	var waits []time.Duration
	calls := 0
	readFileOnce = func(name string) ([]byte, error) {
		calls++
		return f(name)
	}
	readTransient = func(err error) bool { return errors.Is(err, errBusy) || errors.Is(err, fs.ErrNotExist) }
	retryWait = func(d time.Duration) { waits = append(waits, d) }
	return &waits, &calls
}

func busy(name string) error { return &os.PathError{Op: "open", Path: name, Err: errBusy} }

func TestReadJSONRetriesATransientErrorUntilTheReadSucceeds(t *testing.T) {
	st := &Store{Dir: t.TempDir()}
	fails := 2
	waits, calls := stubRead(t, func(name string) ([]byte, error) {
		if fails > 0 {
			fails--
			return nil, busy(name)
		}
		return []byte(`{"name":"n"}`), nil
	})
	var c Config
	ok, err := st.ReadJSON("config.json", &c)
	if err != nil || !ok || c.Name != "n" {
		t.Fatalf("ReadJSON = %v, %v, %+v; want the file read after the retries", ok, err, c)
	}
	if *calls != 3 || len(*waits) != 2 {
		t.Fatalf("%d reads and %d waits, want 3 and 2", *calls, len(*waits))
	}
}

func TestReadJSONReturnsTheTransientErrorOnceItsBudgetIsSpent(t *testing.T) {
	st := &Store{Dir: t.TempDir()}
	waits, calls := stubRead(t, func(name string) ([]byte, error) { return nil, busy(name) })
	var c Config
	ok, err := st.ReadJSON("config.json", &c)
	if ok || !errors.Is(err, errBusy) {
		t.Fatalf("ReadJSON = %v, %v; want the transient error", ok, err)
	}
	var total time.Duration
	for _, w := range *waits {
		total += w
	}
	// Each wait is less than twice the one before, so stopping only when the next wait would pass the
	// budget means more than a third of it was spent.
	if *calls != len(*waits)+1 || total > retryBudget || 3*total <= retryBudget {
		t.Fatalf("%d reads, %d waits for %v in all; want one read per wait plus one, within %v and over a third of it",
			*calls, len(*waits), total, retryBudget)
	}
}

// A missing file is the common answer for an optional file; it is never retried, even if the
// platform's check would call its error transient.
func TestReadJSONReportsAMissingFileAtOnce(t *testing.T) {
	st := &Store{Dir: t.TempDir()}
	waits, calls := stubRead(t, func(name string) ([]byte, error) {
		return nil, &os.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
	})
	var c Config
	ok, err := st.ReadJSON("config.json", &c)
	if ok || err != nil {
		t.Fatalf("ReadJSON = %v, %v; want absent", ok, err)
	}
	if *calls != 1 || len(*waits) != 0 {
		t.Fatalf("%d reads and %d waits, want 1 and 0", *calls, len(*waits))
	}
}

func TestReadJSONReturnsAPermanentErrorAtOnce(t *testing.T) {
	st := &Store{Dir: t.TempDir()}
	broken := errors.New("broken")
	waits, calls := stubRead(t, func(name string) ([]byte, error) {
		return nil, &os.PathError{Op: "open", Path: name, Err: broken}
	})
	var c Config
	if _, err := st.ReadJSON("config.json", &c); !errors.Is(err, broken) {
		t.Fatalf("ReadJSON: %v, want broken", err)
	}
	if *calls != 1 || len(*waits) != 0 {
		t.Fatalf("%d reads and %d waits, want 1 and 0", *calls, len(*waits))
	}
}
