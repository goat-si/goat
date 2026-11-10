package cli

import (
	"bytes"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
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
	ppid, err := exec.Command("ps", "-o", "ppid=", "-p", strconv.Itoa(s.PID)).Output()
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(ppid)); got == strconv.Itoa(os.Getpid()) {
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
	stat, _ := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(s.PID)).Output()
	if st := strings.TrimSpace(string(stat)); st != "" && !strings.HasPrefix(st, "Z") {
		t.Fatalf("pen down returned while daemon %d was still running (state %q)", s.PID, st)
	}
}

// storeWithRelay is a founded node whose config.json names relay, as an older pen could write it.
func storeWithRelay(t *testing.T, relay string) *state.Store {
	t.Helper()
	st := tmpStore(t)
	id, _, err := st.EnsureIdentity()
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SaveConfig(state.Config{Relay: relay, Name: "t"}); err != nil {
		t.Fatal(err)
	}
	if _, err := mesh.Found(st, id, "t", 1); err != nil {
		t.Fatal(err)
	}
	return st
}

// A relay list the daemon refuses is a reason pen up must print, not a service that never answers.
func TestUpWithAStoredRelayTheDaemonRefusesPrintsWhyAndStartsNothing(t *testing.T) {
	st := storeWithRelay(t, "http://relay.example.com")
	t.Setenv("PEN_TEST_MAIN", "1")
	t.Setenv("PEN_HOME", st.Dir)
	t.Setenv("PEN_SERVICE", "none")
	var out, errOut bytes.Buffer
	code := RunUp([]string{"--no-service"}, &out, &errOut)
	t.Cleanup(func() { RunDown(nil, io.Discard, io.Discard) })
	if code == 0 || !strings.Contains(errOut.String(), "cannot be used") {
		t.Fatalf("pen up exit %d: %q; want the relay refusal", code, errOut.String())
	}
	var s daemon.Status
	if err := daemon.Call(st, daemon.Request{Op: "status"}, &s); err == nil {
		t.Fatal("a daemon runs with a relay list it refuses")
	}
}

// The service runs pen up --foreground and restarts it on a non-zero exit (systemd Restart=on-failure,
// launchd SuccessfulExit=false); a configuration it refuses would restart forever.
func TestUpForegroundWithARefusedRelayListExitsZeroWithTheReason(t *testing.T) {
	st := storeWithRelay(t, "http://relay.example.com")
	t.Setenv("PEN_HOME", st.Dir)
	var out, errOut bytes.Buffer
	if code := RunUp([]string{"--foreground"}, &out, &errOut); code != 0 || !strings.Contains(errOut.String(), "cannot be used") {
		t.Fatalf("exit %d: %q; want 0 and the refusal", code, errOut.String())
	}
}
