package daemon

import (
	"bytes"
	"context"
	"os"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
)

// daemon.log is written through an append handle the service manager (launchd) or the detaching
// pen up holds, so it grows without bound unless the daemon itself cuts it.
func TestTheDaemonCutsAnOversizedLogAndTheAppendHandleKeepsWriting(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	st := shortDir(t)
	id := identity(t, st, rs.URL, "a")
	if _, err := mesh.Found(st, id, "a", 1); err != nil {
		t.Fatal(err)
	}
	logPath := st.Path("daemon.log")
	w, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	old := bytes.Repeat([]byte("old line\n"), (5<<20)/9)
	if _, err := w.Write(old); err != nil {
		t.Fatal(err)
	}
	start(t, ctx, rs, st, nil)
	if _, err := w.Write([]byte("after\n")); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "after\n" {
		t.Fatalf("daemon.log holds %d bytes after the cut, want only the new line", len(got))
	}
	kept, err := os.ReadFile(logPath + ".1")
	if err != nil || !bytes.Equal(kept, old) {
		t.Fatalf("daemon.log.1 holds %d bytes (%v), want the %d bytes cut", len(kept), err, len(old))
	}
}
