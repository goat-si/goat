package cli

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

func TestUpForegroundAfterLeaveExitsZeroWithoutANewIdentityOrMesh(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PEN_HOME", dir)
	st, err := state.OpenDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(st.Path(daemon.LeftMarker), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	if code := RunUp([]string{"--foreground"}, &out, &errOut); code != 0 {
		t.Fatalf("exit %d (%s); a service restart after leave must not loop", code, errOut.String())
	}
	if _, err := st.LoadIdentity(); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a new identity was created after leave: %v", err)
	}
	if _, err := os.Stat(st.Path("mesh.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a new mesh was founded after leave")
	}
}

func TestNoServiceDaemonIsNotAChildOfTheCommandThatStartedIt(t *testing.T) {
	rs := relaytest.New()
	defer rs.Close()
	st := tmpStore(t)
	t.Setenv("PEN_TEST_MAIN", "1")
	t.Setenv("PEN_HOME", st.Dir)
	t.Setenv("PEN_SERVICE", "none")
	t.Setenv("PEN_HOSTKEYS", "none")
	t.Setenv("PEN_SSH_DIR", filepath.Join(st.Dir, "ssh"))
	var out, errOut bytes.Buffer
	code := RunUp([]string{"--no-service", "--relay", rs.URL, "--name", "t"}, &out, &errOut)
	t.Cleanup(func() { RunDown(nil, io.Discard, io.Discard) })
	if code != 0 {
		t.Fatalf("pen up exit %d: %s", code, errOut.String())
	}
	var s daemon.Status
	if err := daemon.Call(st, daemon.Request{Op: "status"}, &s); err != nil {
		t.Fatal(err)
	}
	if got := parentPID(s.PID); got == strconv.Itoa(os.Getpid()) {
		t.Fatalf("daemon %d is still a child of the pen up that started it (ppid %s)", s.PID, got)
	}
}

func TestDownReturnsOnlyOnceTheDaemonHasExited(t *testing.T) {
	rs := relaytest.New()
	defer rs.Close()
	st := tmpStore(t)
	t.Setenv("PEN_TEST_MAIN", "1")
	t.Setenv("PEN_HOME", st.Dir)
	t.Setenv("PEN_SERVICE", "none")
	t.Setenv("PEN_HOSTKEYS", "none")
	t.Setenv("PEN_SSH_DIR", filepath.Join(st.Dir, "ssh"))
	var out, errOut bytes.Buffer
	if code := RunUp([]string{"--no-service", "--relay", rs.URL, "--name", "t"}, &out, &errOut); code != 0 {
		t.Fatalf("pen up exit %d: %s", code, errOut.String())
	}
	t.Cleanup(func() { RunDown(nil, io.Discard, io.Discard) })
	var s daemon.Status
	if err := daemon.Call(st, daemon.Request{Op: "status"}, &s); err != nil {
		t.Fatal(err)
	}
	if code := RunDown(nil, io.Discard, &errOut); code != 0 {
		t.Fatalf("pen down exit %d: %s", code, errOut.String())
	}
	// Scripts remove or replace the state directory and the binary right after pen down.
	if running(s.PID) {
		t.Fatalf("pen down returned while daemon %d was still running", s.PID)
	}
}
