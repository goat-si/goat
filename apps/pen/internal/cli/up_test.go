package cli

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

func TestUpAsTheServiceAfterLeaveExitsZeroWithoutANewIdentityOrMesh(t *testing.T) {
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
	if code := RunUp([]string{"--foreground", "--service"}, &out, &errOut); code != 0 {
		t.Fatalf("exit %d (%s); a service restart after leave must not loop", code, errOut.String())
	}
	if code := RunUp([]string{"--foreground"}, &out, &errOut); code == 0 {
		t.Fatal("pen up --foreground after leave exited 0 for a person or another supervisor")
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

// The service runs pen up --foreground --service and restarts it on a non-zero exit (systemd
// Restart=on-failure, launchd SuccessfulExit=false); a configuration it refuses would restart forever.
func TestUpAsTheServiceWithARefusedRelayListExitsZeroWithTheReason(t *testing.T) {
	st := storeWithRelay(t, "http://relay.example.com")
	t.Setenv("PEN_HOME", st.Dir)
	var out, errOut bytes.Buffer
	if code := RunUp([]string{"--foreground", "--service"}, &out, &errOut); code != 0 || !strings.Contains(errOut.String(), "cannot be used") {
		t.Fatalf("exit %d: %q; want 0 and the refusal", code, errOut.String())
	}
}

// A person's pen up ends a pen down even when Pen then runs without the service, so a later sign-in
// starts the task again.
func TestUpClearsTheDownRecordAlsoWithoutTheService(t *testing.T) {
	rs := relaytest.New()
	defer rs.Close()
	st := tmpStore(t)
	t.Setenv("PEN_TEST_MAIN", "1")
	t.Setenv("PEN_HOME", st.Dir)
	t.Setenv("PEN_HOSTKEYS", "none")
	t.Setenv("PEN_SSH_DIR", filepath.Join(st.Dir, "ssh"))
	if err := st.WriteAtomic(downMarker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	code := RunUp([]string{"--no-service", "--relay", rs.URL, "--name", "t"}, &out, &errOut)
	t.Cleanup(func() { RunDown(nil, io.Discard, io.Discard) })
	if code != 0 {
		t.Fatalf("pen up exit %d: %s", code, errOut.String())
	}
	if _, err := os.Stat(st.Path(downMarker)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the down record survived pen up: %v", err)
	}
}

// A person or another supervisor running pen up --foreground must not read a refused start as success.
func TestUpForegroundWithARefusedOrMissingRelayListFails(t *testing.T) {
	t.Setenv("SYSTEMD_EXEC_PID", "")
	t.Setenv("XPC_SERVICE_NAME", "")
	for _, relay := range []string{"http://relay.example.com", ""} {
		st := storeWithRelay(t, relay)
		t.Setenv("PEN_HOME", st.Dir)
		var out, errOut bytes.Buffer
		if code := RunUp([]string{"--foreground"}, &out, &errOut); code == 0 {
			t.Fatalf("relay %q: exit 0 (%q); want a failure", relay, errOut.String())
		}
	}
}

// A unit written before --service runs plain pen up --foreground. Started by systemd (which sets
// SYSTEMD_EXEC_PID to the pid it started) or by launchd (XPC_SERVICE_NAME is the job's label), a
// refused start still exits 0 so an upgraded machine does not restart it every 2 s; a shell that
// only inherited systemd's variable does not count.
func TestUpForegroundStartedByAServiceManagerExitsZeroOnARefusedRelayList(t *testing.T) {
	for _, c := range []struct {
		pid, label string
		want       bool
	}{
		{strconv.Itoa(os.Getpid()), "", true},
		{"", launchdLabel, true},
		{strconv.Itoa(os.Getpid() + 1), "com.apple.Terminal", false},
	} {
		st := storeWithRelay(t, "http://relay.example.com")
		t.Setenv("PEN_HOME", st.Dir)
		t.Setenv("SYSTEMD_EXEC_PID", c.pid)
		t.Setenv("XPC_SERVICE_NAME", c.label)
		var out, errOut bytes.Buffer
		if code := RunUp([]string{"--foreground"}, &out, &errOut); (code == 0) != c.want {
			t.Fatalf("SYSTEMD_EXEC_PID=%q XPC_SERVICE_NAME=%q: exit %d, want exit 0 %v", c.pid, c.label, code, c.want)
		}
	}
}

// The service files run the service invocation, so a refused configuration stops them instead of looping.
func TestTheServiceFilesRunTheServiceInvocation(t *testing.T) {
	for name, tmpl := range map[string]string{"pen.service": "../../install/pen.service", "si.goat.pen.plist": "../../install/si.goat.pen.plist"} {
		b, err := os.ReadFile(tmpl)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(b), "--service") {
			t.Fatalf("%s does not pass --service", name)
		}
	}
}

// After the service stopped on a refused relay list, pen up --relay with a usable relay starts the node.
func TestUpWithAUsableRelayRecoversAfterTheServiceStoppedOnARefusedOne(t *testing.T) {
	rs := relaytest.New()
	defer rs.Close()
	st := storeWithRelay(t, "http://relay.example.com")
	t.Setenv("PEN_TEST_MAIN", "1")
	t.Setenv("PEN_HOME", st.Dir)
	t.Setenv("PEN_SERVICE", "none")
	t.Setenv("PEN_HOSTKEYS", "none")
	t.Setenv("PEN_SSH_DIR", filepath.Join(st.Dir, "ssh"))
	var out, errOut bytes.Buffer
	if code := RunUp([]string{"--foreground", "--service"}, &out, &errOut); code != 0 {
		t.Fatalf("service start exit %d: %s", code, errOut.String())
	}
	code := RunUp([]string{"--no-service", "--relay", rs.URL}, &out, &errOut)
	t.Cleanup(func() { RunDown(nil, io.Discard, io.Discard) })
	if code != 0 {
		t.Fatalf("pen up --relay exit %d: %s", code, errOut.String())
	}
	var s daemon.Status
	if err := daemon.Call(st, daemon.Request{Op: "status"}, &s); err != nil {
		t.Fatalf("no daemon after pen up --relay: %v", err)
	}
}
