package cli

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf16"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

const testAccount = `DESKTOP-1\User`

// taskDef is the part of a task definition the tests check.
type taskDef struct {
	LogonUser string `xml:"Triggers>LogonTrigger>UserId"`
	User      string `xml:"Principals>Principal>UserId"`
	LogonType string `xml:"Principals>Principal>LogonType"`
	TimeLimit string `xml:"Settings>ExecutionTimeLimit"`
	NoBattery string `xml:"Settings>DisallowStartIfOnBatteries"`
	StopBatt  string `xml:"Settings>StopIfGoingOnBatteries"`
	Instances string `xml:"Settings>MultipleInstancesPolicy"`
	Command   string `xml:"Actions>Exec>Command"`
	Arguments string `xml:"Actions>Exec>Arguments"`
}

func parseTask(t *testing.T, file []byte) taskDef {
	t.Helper()
	if len(file) < 2 || file[0] != 0xff || file[1] != 0xfe || len(file)%2 != 0 {
		t.Fatalf("task XML is not UTF-16LE with a byte order mark")
	}
	u := make([]uint16, (len(file)-2)/2)
	for i := range u {
		u[i] = binary.LittleEndian.Uint16(file[2+2*i:])
	}
	dec := xml.NewDecoder(strings.NewReader(string(utf16.Decode(u))))
	dec.CharsetReader = func(_ string, r io.Reader) (io.Reader, error) { return r, nil }
	var def taskDef
	if err := dec.Decode(&def); err != nil {
		t.Fatalf("task XML: %v", err)
	}
	return def
}

// windowsHome is a scratch default home (no PEN_HOME) on a pretend Windows with Task Scheduler, the
// account testAccount and a recording schtasks; on is called for each schtasks verb.
func windowsHome(t *testing.T, on func(verb string, args []string) error) (*state.Store, *[]string) {
	t.Helper()
	home, err := os.MkdirTemp(tmpRoot(), "penh")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	setHome(t, home)
	t.Setenv("PEN_HOME", "")
	t.Setenv("PEN_SERVICE", "")
	t.Setenv("PEN_TEST_MAIN", "1")
	t.Setenv("PEN_HOSTKEYS", "none")
	t.Setenv("PEN_SSH_DIR", filepath.Join(home, "ssh"))
	tmpl, err := os.ReadFile("../../install/pen-task.xml")
	if err != nil {
		t.Fatal(err)
	}
	oldOS, oldRun, oldAccount, oldXML := serviceOS, run, currentAccount, TaskXML
	t.Cleanup(func() { serviceOS, run, currentAccount, TaskXML = oldOS, oldRun, oldAccount, oldXML })
	serviceOS, TaskXML = "windows", string(tmpl)
	currentAccount = func() (string, error) { return testAccount, nil }
	calls := &[]string{}
	var callsMu sync.Mutex
	run = func(name string, args ...string) error {
		callsMu.Lock()
		*calls = append(*calls, name+" "+strings.Join(args, " "))
		callsMu.Unlock()
		if name != "schtasks" {
			t.Fatalf("ran %s %v", name, args)
		}
		return on(args[0], args)
	}
	st, err := state.OpenDir(filepath.Join(home, ".pen"))
	if err != nil {
		t.Fatal(err)
	}
	return st, calls
}

// runningNode founds a mesh in st and starts its daemon as a separate process, as the task would.
func runningNode(t *testing.T, st *state.Store, rs *relaytest.Server) daemon.Status {
	t.Helper()
	var out, errOut bytes.Buffer
	if code := RunUp([]string{"--no-service", "--relay", rs.URL, "--name", "a"}, &out, &errOut); code != 0 {
		t.Fatalf("pen up exit %d: %s", code, errOut.String())
	}
	t.Cleanup(func() { daemon.Call(st, daemon.Request{Op: "stop"}, &map[string]bool{}) })
	var s daemon.Status
	if err := daemon.Call(st, daemon.Request{Op: "status"}, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestUpOnWindowsRegistersALogonTaskForTheAccountAndStartsIt(t *testing.T) {
	rs := relaytest.New()
	defer rs.Close()
	var def taskDef
	var xmlPath string
	st, calls := windowsHome(t, nil)
	run = func(name string, args ...string) error {
		*calls = append(*calls, name+" "+strings.Join(args, " "))
		switch args[0] {
		case "/Query":
			return errors.New("not registered")
		case "/Create":
			xmlPath = args[4]
			b, err := os.ReadFile(xmlPath)
			if err != nil {
				t.Fatal(err)
			}
			def = parseTask(t, b)
		case "/Run":
			// The task's action starts the daemon; stand in with a detached one.
			if err := startDetached(st); err != nil {
				t.Fatal(err)
			}
		}
		return nil
	}
	var out, errOut bytes.Buffer
	code := RunUp([]string{"--relay", rs.URL, "--name", "a"}, &out, &errOut)
	t.Cleanup(func() { daemon.Call(st, daemon.Request{Op: "stop"}, &map[string]bool{}) })
	if code != 0 {
		t.Fatalf("pen up exit %d: %s", code, errOut.String())
	}
	name := taskName(testAccount)
	want := []string{"schtasks /Create /TN " + name + " /XML " + xmlPath + " /F", "schtasks /Run /TN " + name}
	if strings.Join(*calls, "\n") != strings.Join(want, "\n") {
		t.Fatalf("schtasks calls:\n%s\nwant:\n%s", strings.Join(*calls, "\n"), strings.Join(want, "\n"))
	}
	exe, _ := exePath()
	if def.LogonUser != testAccount || def.User != testAccount || def.LogonType != "InteractiveToken" ||
		def.TimeLimit != "PT0S" || def.NoBattery != "false" || def.StopBatt != "false" || def.Instances != "IgnoreNew" ||
		def.Command != exe || def.Arguments != "up --supervise" {
		t.Fatalf("task definition %+v", def)
	}
	if _, err := os.Stat(xmlPath); !os.IsNotExist(err) {
		t.Fatalf("the task XML was left in the state directory: %v", err)
	}
}

func TestTaskXMLEscapesThePathAndAccount(t *testing.T) {
	tmpl, err := os.ReadFile("../../install/pen-task.xml")
	if err != nil {
		t.Fatal(err)
	}
	old := TaskXML
	t.Cleanup(func() { TaskXML = old })
	TaskXML = string(tmpl)
	exe, account := `C:\Program Files\R&D <x>\pen.exe`, `D&D\a<b`
	xml, err := renderTask(exe, account)
	if err != nil {
		t.Fatal(err)
	}
	def := parseTask(t, utf16File(xml))
	if def.Command != exe || def.User != account || def.LogonUser != account {
		t.Fatalf("task definition %+v", def)
	}
}

// Task Scheduler expands %VAR% in the action's path and has no escape for it, so like the systemd unit
// and the plist the task refuses a path it cannot carry exactly.
func TestTaskRefusesAPathTaskSchedulerWouldChange(t *testing.T) {
	for _, exe := range []string{`C:\Users\100%USERNAME%\pen.exe`, "C:\\a\x01\\pen.exe", "C:\\a\xff\\pen.exe"} {
		if _, err := renderTask(exe, testAccount); err == nil {
			t.Fatalf("renderTask accepted %q", exe)
		}
	}
	st, _ := windowsHome(t, func(string, []string) error { return nil })
	old := exePath
	t.Cleanup(func() { exePath = old })
	exePath = func() (string, error) { return `C:\Users\100%USERNAME%\pen.exe`, nil }
	if err := startTask(st); err == nil || !strings.Contains(err.Error(), "%USERNAME%") {
		t.Fatalf("startTask: %v, want a refusal naming the path", err)
	}
}

func TestTaskNamesKeepAccountsWithTheSameShortNameApart(t *testing.T) {
	a, b := taskName(`DOMAIN1\Alice`), taskName(`DOMAIN2\alice`)
	if a == b || !strings.HasPrefix(a, "pen-alice-") || !strings.HasPrefix(b, "pen-alice-") {
		t.Fatalf("task names %q and %q", a, b)
	}
	if got := taskName(`PC\Jun Kim (work)`); !strings.HasPrefix(got, "pen-jun-kim-work-") {
		t.Fatalf("task name %q", got)
	}
}

func TestDownOnWindowsStopsTheTaskDaemonThroughItsControlSocket(t *testing.T) {
	rs := relaytest.New()
	defer rs.Close()
	st, calls := windowsHome(t, func(string, []string) error { return nil })
	s := runningNode(t, st, rs)
	*calls = nil
	var out, errOut bytes.Buffer
	if code := RunDown(nil, &out, &errOut); code != 0 {
		t.Fatalf("pen down exit %d: %s", code, errOut.String())
	}
	if want := "schtasks /Query /TN " + taskName(testAccount); strings.Join(*calls, "\n") != want {
		t.Fatalf("schtasks calls %q, want only %q (no /End for a daemon that stopped)", *calls, want)
	}
	if running(s.PID) {
		t.Fatalf("daemon %d still runs after pen down", s.PID)
	}
}

func TestLeaveOnWindowsDeletesTheTaskOnlyAfterLeaving(t *testing.T) {
	rs := relaytest.New()
	defer rs.Close()
	var st *state.Store
	deleted := false
	st, calls := windowsHome(t, func(verb string, _ []string) error {
		if verb == "/Delete" {
			if daemon.Call(st, daemon.Request{Op: "status"}, &daemon.Status{}) == nil {
				t.Fatal("the task was deleted while the daemon still ran")
			}
			deleted = true
		}
		return nil
	})
	runningNode(t, st, rs)
	var out, errOut bytes.Buffer
	if code := RunLeave(nil, &out, &errOut); code != 0 {
		t.Fatalf("pen leave exit %d: %s", code, errOut.String())
	}
	if !deleted || !strings.HasPrefix((*calls)[len(*calls)-1], "schtasks /Delete /TN "+taskName(testAccount)+" /F") {
		t.Fatalf("schtasks calls %q; want the task deleted last", *calls)
	}
	if _, err := os.Stat(st.Path(daemon.LeftMarker)); err != nil {
		t.Fatalf("no left marker, so a task start could found a new node: %v", err)
	}
}

func TestSupervisorRestartsACrashedDaemonUntilItExitsCleanly(t *testing.T) {
	clock := time.Unix(0, 0)
	// Exit codes with how long each run lasted: two fast crashes, one after an hour, a fast one, then pen down.
	runs := []struct {
		code int
		took time.Duration
	}{{2, time.Second}, {2, time.Second}, {2, time.Hour}, {1, time.Second}, {0, time.Second}}
	var waits []time.Duration
	i := 0
	code := superviseLoop(func() int {
		r := runs[i]
		i++
		clock = clock.Add(r.took)
		return r.code
	}, func() bool { return false }, func(d time.Duration) { waits = append(waits, d); clock = clock.Add(d) },
		func() time.Time { return clock }, func(string, ...any) {})
	if code != 0 || i != len(runs) {
		t.Fatalf("supervisor returned %d after %d runs", code, i)
	}
	want := []time.Duration{2 * time.Second, 4 * time.Second, 2 * time.Second, 4 * time.Second}
	if len(waits) != len(want) {
		t.Fatalf("waits %v, want %v", waits, want)
	}
	for k := range want {
		if waits[k] != want[k] {
			t.Fatalf("waits %v, want %v", waits, want)
		}
	}
}

// pen down marks the stop before it asks the daemon; a daemon that crashes instead of stopping must not
// come back, whether the supervisor notices before or after its wait.
func TestSupervisorDoesNotRestartADaemonAfterPenDown(t *testing.T) {
	for _, markAt := range []string{"exit", "wait"} {
		down := false
		runs := 0
		code := superviseLoop(func() int {
			runs++
			if markAt == "exit" {
				down = true
			}
			return 2
		}, func() bool { return down }, func(time.Duration) {
			if markAt == "wait" {
				down = true
			}
		}, time.Now, func(string, ...any) {})
		if code != 0 || runs != 1 {
			t.Fatalf("down marked at %s: supervisor returned %d after %d runs, want 0 after 1", markAt, code, runs)
		}
	}
}

// A supervisor that starts after pen down (a sign-in, or one that was just starting) starts nothing until
// pen up removes the record.
func TestSupervisorStartsNoDaemonWhilePenDownIsRecorded(t *testing.T) {
	runs := 0
	code := superviseLoop(func() int { runs++; return 0 }, func() bool { return true },
		func(time.Duration) {}, time.Now, func(string, ...any) {})
	if code != 0 || runs != 0 {
		t.Fatalf("supervisor returned %d after %d runs, want 0 runs", code, runs)
	}
}

// Task Scheduler can still count a just-ended supervisor as running and drop pen up's /Run (IgnoreNew);
// pen up runs the task again until the daemon answers.
func TestUpOnWindowsRunsTheTaskAgainWhenTheFirstRunIsDropped(t *testing.T) {
	rs := relaytest.New()
	defer rs.Close()
	var st *state.Store
	runsSeen := 0
	st, calls := windowsHome(t, func(verb string, _ []string) error {
		switch verb {
		case "/Query":
			return errors.New("not registered")
		case "/Run":
			runsSeen++
			if runsSeen == 2 {
				if err := startDetached(st); err != nil {
					t.Fatal(err)
				}
			}
		}
		return nil
	})
	fakeTaskClock(t)
	var out, errOut bytes.Buffer
	code := RunUp([]string{"--relay", rs.URL, "--name", "a"}, &out, &errOut)
	t.Cleanup(func() { daemon.Call(st, daemon.Request{Op: "stop"}, &map[string]bool{}) })
	if code != 0 || runsSeen != 2 {
		t.Fatalf("pen up exit %d after %d /Run calls (%q): %s", code, runsSeen, *calls, errOut.String())
	}
}

// A daemon that outlives its supervisor (started just before the supervisor saw pen down, then the
// supervisor was ended with /End) is stopped too.
func TestDownOnWindowsStopsADaemonThatOutlivedItsSupervisor(t *testing.T) {
	rs := relaytest.New()
	defer rs.Close()
	var release func()
	st, _ := windowsHome(t, func(verb string, _ []string) error {
		if verb == "/End" {
			release()
		}
		return nil
	})
	s := runningNode(t, st, rs)
	r, err := state.TryLock(st.Path(supervisorLock))
	if err != nil {
		t.Fatal(err)
	}
	release = r
	old := supervisorWait
	supervisorWait = 0
	defer func() { supervisorWait = old }()
	var out, errOut bytes.Buffer
	if code := RunDown(nil, &out, &errOut); code != 0 {
		t.Fatalf("pen down exit %d: %s", code, errOut.String())
	}
	if running(s.PID) {
		t.Fatalf("daemon %d still runs after pen down", s.PID)
	}
}

// pen down returns only once the supervisor has ended, so the next pen up's /Run is not dropped; a
// supervisor that outlives the graceful stop is ended with /End, and one that survives that is an error.
func TestDownOnWindowsWaitsForTheSupervisorAndEndsOneThatStays(t *testing.T) {
	for _, endWorks := range []bool{true, false} {
		var release func()
		st, calls := windowsHome(t, func(verb string, _ []string) error {
			switch verb {
			case "/Query":
				return nil
			case "/End":
				if endWorks {
					release()
					return nil
				}
				return errors.New("access denied")
			}
			return nil
		})
		r, err := state.TryLock(st.Path(supervisorLock)) // a supervisor that does not end by itself
		if err != nil {
			t.Fatal(err)
		}
		release = r
		old := supervisorWait
		supervisorWait = 0
		var out, errOut bytes.Buffer
		code := RunDown(nil, &out, &errOut)
		supervisorWait = old
		if !endWorks {
			release()
		}
		if want := "schtasks /End /TN " + taskName(testAccount); !strings.Contains(strings.Join(*calls, "\n"), want) {
			t.Fatalf("calls %q lack %q", *calls, want)
		}
		if endWorks && code != 0 {
			t.Fatalf("pen down exit %d after /End ended the supervisor: %s", code, errOut.String())
		}
		if !endWorks && (code == 0 || !strings.Contains(errOut.String(), "did not stop")) {
			t.Fatalf("pen down exit %d (%s) with a supervisor still running", code, errOut.String())
		}
		if _, err := os.Stat(st.Path(downMarker)); err != nil {
			t.Fatalf("pen down left no down marker: %v", err)
		}
	}
}

// The task's supervisor follows the --service rule: a start it refuses ends it with exit 0, so nothing
// counts a failure or restarts it, and the reason is left in daemon.log and in the record pen up reads.
func TestSupervisorOnARefusedRelayListEndsCleanlyAndLeavesTheReason(t *testing.T) {
	st := storeWithRelay(t, "http://relay.example.com")
	t.Setenv("PEN_HOME", st.Dir)
	cfg, err := st.LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	reason := daemon.CheckConfig(cfg)
	if reason == nil {
		t.Fatal("the test relay list is accepted")
	}
	var out, errOut bytes.Buffer
	if code := RunUp([]string{"--supervise"}, &out, &errOut); code != 0 {
		t.Fatalf("pen up --supervise exit %d (%s), want 0", code, errOut.String())
	}
	for _, f := range []string{"daemon.log", refusedRecord} {
		b, err := os.ReadFile(st.Path(f))
		if err != nil || !strings.Contains(string(b), reason.Error()) {
			t.Fatalf("%s does not carry the reason %q: %q, %v", f, reason, b, err)
		}
	}
}

// The supervisor runs the daemon with the service invocation: a daemon that refuses its start (its config
// changed after the supervisor checked it) ends the supervisor instead of being restarted every 2 s.
func TestSupervisorDoesNotRestartADaemonThatRefusedItsStart(t *testing.T) {
	st := storeWithRelay(t, "http://relay.example.com")
	t.Setenv("PEN_HOME", st.Dir)
	t.Setenv("PEN_TEST_MAIN", "1")
	old := superviseWait
	t.Cleanup(func() { superviseWait = old; debug.SetCrashOutput(nil, debug.CrashOptions{}) })
	superviseWait = func(d time.Duration) {
		t.Errorf("the supervisor restarts the daemon after %v", d)
		st.WriteAtomic(downMarker, nil, 0o600) // ends the loop
	}
	if code := runSupervised(st, io.Discard, "req1"); code != 0 {
		t.Fatalf("supervisor exit %d", code)
	}
	if b, _ := os.ReadFile(st.Path(refusedRecord)); runtime.GOOS == "windows" && !strings.HasPrefix(string(b), "req1\n") {
		t.Fatalf("the daemon's refusal left no record of start req1 for pen up: %q", b)
	}
}

// pen up reports a start the task's supervisor refused, with its reason, instead of running the task again.
func TestUpOnWindowsReportsAStartTheSupervisorRefused(t *testing.T) {
	rs := relaytest.New()
	defer rs.Close()
	var st *state.Store
	runs := 0
	st, calls := windowsHome(t, func(verb string, _ []string) error {
		switch verb {
		case "/Query":
			return errors.New("not registered")
		case "/Run":
			runs++
			if runs > 1 {
				t.Fatalf("pen up ran the task again after the supervisor refused the start")
			}
			req, err := os.ReadFile(st.Path(startRequest))
			if err != nil {
				t.Fatal(err)
			}
			if err := st.WriteAtomic(refusedRecord, []byte(string(req)+"\npen: this node left its mesh\n"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		return nil
	})
	if err := st.WriteAtomic(refusedRecord, []byte("old\npen: an older refusal\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	code := RunUp([]string{"--relay", rs.URL, "--name", "a"}, &out, &errOut)
	if code == 0 || !strings.Contains(errOut.String(), "this node left its mesh") {
		t.Fatalf("pen up exit %d (%q): %s", code, *calls, errOut.String())
	}
}

// fakeTaskClock makes pen up's waits for the task advance a fake clock instead of sleeping.
func fakeTaskClock(t *testing.T) {
	t.Helper()
	oldNow, oldSleep := taskNow, taskSleep
	t.Cleanup(func() { taskNow, taskSleep = oldNow, oldSleep })
	var mu sync.Mutex
	clock := time.Unix(0, 0)
	taskNow = func() time.Time { mu.Lock(); defer mu.Unlock(); return clock }
	taskSleep = func(d time.Duration) { mu.Lock(); clock = clock.Add(d); mu.Unlock() }
}

// A refusal an earlier start recorded late (its supervisor checked the configuration before this pen up
// and wrote its reason after pen up cleared the record) is not this start's: pen up runs the task again.
func TestUpOnWindowsIgnoresARefusalOfAnEarlierStart(t *testing.T) {
	rs := relaytest.New()
	defer rs.Close()
	var st *state.Store
	runs := 0
	st, calls := windowsHome(t, func(verb string, _ []string) error {
		switch verb {
		case "/Query":
			return errors.New("not registered")
		case "/Run":
			runs++
			if runs == 1 {
				if err := st.WriteAtomic(refusedRecord, []byte("earlier\npen: an earlier refusal\n"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if runs == 2 {
				if err := startDetached(st); err != nil {
					t.Fatal(err)
				}
			}
		}
		return nil
	})
	fakeTaskClock(t)
	var out, errOut bytes.Buffer
	code := RunUp([]string{"--relay", rs.URL, "--name", "a"}, &out, &errOut)
	t.Cleanup(func() { daemon.Call(st, daemon.Request{Op: "stop"}, &map[string]bool{}) })
	if code != 0 || runs != 2 {
		t.Fatalf("pen up exit %d after %d /Run calls (%q): %s", code, runs, *calls, errOut.String())
	}
}

// The supervisor records the start request it was run for, so its refusal names that start.
func TestSupervisorRecordsItsRefusalForTheStartRequestItSaw(t *testing.T) {
	st := storeWithRelay(t, "http://relay.example.com")
	t.Setenv("PEN_HOME", st.Dir)
	if err := st.WriteAtomic(startRequest, []byte("req7"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	if code := RunUp([]string{"--supervise"}, &out, &errOut); code != 0 {
		t.Fatalf("pen up --supervise exit %d (%s)", code, errOut.String())
	}
	if b, _ := os.ReadFile(st.Path(refusedRecord)); !strings.HasPrefix(string(b), "req7\npen: ") {
		t.Fatalf("start-refused = %q, want the reason for req7", b)
	}
}

// Two pen up starting the task at once take turns: the supervisor reads one start request at a time, so
// each caller gets the refusal of the start it asked for instead of losing it to the other's id.
func TestOverlappingTaskStartsEachGetTheirOwnRefusal(t *testing.T) {
	var st *state.Store
	var mu sync.Mutex
	bWaiting := make(chan struct{})
	aDone := make(chan struct{})
	var releaseOnce sync.Once
	releaseB := func() { releaseOnce.Do(func() { close(aDone) }) }
	var bStarted, bWaitedForTurn atomic.Bool
	var once sync.Once
	bReached := func() { once.Do(func() { close(bWaiting) }) }
	var bErr error
	bDone := make(chan struct{})
	runs := 0
	refuse := func() {
		// What a supervisor does: read the current request, then record its refusal for it.
		req, err := os.ReadFile(st.Path(startRequest))
		if err != nil {
			t.Error(err)
			return
		}
		if err := st.WriteAtomic(refusedRecord, []byte(string(req)+"\npen: refused for this start\n"), 0o600); err != nil {
			t.Error(err)
		}
	}
	st, _ = windowsHome(t, func(verb string, _ []string) error {
		if verb != "/Run" {
			return nil
		}
		mu.Lock()
		runs++
		first := runs == 1
		mu.Unlock()
		if first {
			// Caller B starts while A waits for its supervisor.
			bStarted.Store(true)
			go func() {
				defer close(bDone)
				bErr = startTask(st)
			}()
			select {
			case <-bWaiting:
			case <-bDone:
			case <-time.After(30 * time.Second):
				t.Error("caller B never reached its start")
			}
		} else {
			bReached() // without turns, B gets here while A still waits
		}
		refuse()
		return nil
	})
	fakeTaskClock(t)
	old := startLockWaits
	t.Cleanup(func() { startLockWaits = old })
	// Join B before restores and home removal (cleanups run last-in first-out); a stuck B fails instead of hanging.
	t.Cleanup(func() {
		releaseB()
		if !bStarted.Load() {
			return
		}
		select {
		case <-bDone:
		case <-time.After(30 * time.Second):
			t.Error("caller B's start did not end; it may still use this test's home")
		}
	})
	startLockWaits = func() {
		bWaitedForTurn.Store(true)
		bReached()
		// B's turn wait advances the fake clock without regard to A, so it starts once A released the turn.
		select {
		case <-aDone:
		case <-time.After(30 * time.Second):
			t.Error("caller A's start did not finish while caller B waited for its turn")
		}
	}
	err := startTask(st)
	releaseB()
	if err == nil || !strings.Contains(err.Error(), "refused for this start") {
		t.Fatalf("caller A: %v, want the refusal of its own start", err)
	}
	select {
	case <-bDone:
	case <-time.After(30 * time.Second):
		t.Fatal("caller B's start did not finish")
	}
	if !bWaitedForTurn.Load() {
		t.Fatal("caller B never waited for caller A's turn: the two starts were not serialized")
	}
	if bErr == nil || !strings.Contains(bErr.Error(), "refused for this start") {
		t.Fatalf("caller B: %v, want the refusal of its own start", bErr)
	}
}

// pen down or pen leave during a pen up that has registered the task but not yet started it: the two
// take turns, so the stop runs after the start is decided and the node ends down, with the down record
// in place, instead of a pen up that resumes after a reported stop and brings the node back.
func TestDownAndLeaveDuringATaskStartEndWithTheNodeDown(t *testing.T) {
	for _, op := range []string{"down", "leave"} {
		t.Run(op, func(t *testing.T) {
			rs := relaytest.New()
			defer rs.Close()
			var st *state.Store
			paused, resume := make(chan struct{}), make(chan struct{})
			var deleted []bool // whether the start had run the task when /Delete ran
			var startDone, startRan atomic.Bool
			st, _ = windowsHome(t, func(verb string, _ []string) error {
				switch verb {
				case "/Create":
					if !startDone.Load() && paused != nil {
						close(paused)
						paused = nil
						<-resume
					}
				case "/Run":
					// Inside the start's turn: a delete that comes after the start sees this.
					startRan.Store(true)
					return startDetached(st)
				case "/Delete":
					deleted = append(deleted, startRan.Load())
				}
				return nil
			})
			cfg := state.Config{Name: "a"}
			cfg.SetRelays([]string{rs.URL})
			if err := st.SaveConfig(cfg); err != nil {
				t.Fatal(err)
			}
			id, _, err := st.EnsureIdentity()
			if err != nil {
				t.Fatal(err)
			}
			if _, err := mesh.Found(st, id, "a", 1); err != nil {
				t.Fatal(err)
			}
			fakeTaskClock(t)
			t.Cleanup(func() { daemon.Call(st, daemon.Request{Op: "stop"}, &map[string]bool{}) })
			// The stop's wait for the turn runs on the test clock; it resumes once the paused start is done.
			waiting, startFinished := make(chan struct{}), make(chan struct{})
			old := startLockWaits
			t.Cleanup(func() { startLockWaits = old })
			startLockWaits = func() { close(waiting); <-startFinished }
			pausedNow := paused
			startErr := make(chan error, 1)
			go func() {
				err := startTask(st)
				startDone.Store(true)
				startErr <- err
			}()
			<-pausedNow
			stopErr := make(chan error, 1)
			go func() {
				if op == "down" {
					stopErr <- stopTask(st)
				} else {
					stopErr <- removeTask(st)
				}
			}()
			stoppedFirst := false
			select {
			case <-waiting: // the stop waits for the start's turn
			case err := <-stopErr:
				stoppedFirst = true
				if err != nil {
					t.Fatalf("pen %s: %v", op, err)
				}
			}
			close(resume)
			if err := <-startErr; err != nil {
				t.Fatalf("pen up: %v", err)
			}
			close(startFinished)
			if !stoppedFirst {
				if err := <-stopErr; err != nil {
					t.Fatalf("pen %s: %v", op, err)
				}
			}
			if _, err := os.Stat(st.Path(downMarker)); err != nil {
				t.Fatalf("pen %s reported success but the down record is gone (stopped first: %v)", op, stoppedFirst)
			}
			var s daemon.Status
			if daemon.Call(st, daemon.Request{Op: "status"}, &s) == nil {
				t.Fatalf("pen %s reported success but the daemon runs (stopped first: %v)", op, stoppedFirst)
			}
			if op == "leave" && (len(deleted) != 1 || !deleted[0]) {
				t.Fatalf("pen leave deleted the task %v (true: after the start ran the task)", deleted)
			}
		})
	}
}

// soloNode gives st a one-member mesh on relay url, as pen up founds it.
func soloNode(t *testing.T, st *state.Store, url string) {
	t.Helper()
	cfg := state.Config{Name: "a"}
	cfg.SetRelays([]string{url})
	if err := st.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	id, _, err := st.EnsureIdentity()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := mesh.Found(st, id, "a", 1); err != nil {
		t.Fatal(err)
	}
}

// The first pen up on a machine registers the task inside its turn. A pen down that looked for a task or
// a daemon before taking the turn would find neither, report success, and then see the start bring the
// node up; pen down takes the turn first, so it stops what the start started and leaves the down record.
func TestDownDuringAFirstTaskStartLeavesTheNodeDown(t *testing.T) {
	rs := relaytest.New()
	defer rs.Close()
	var st *state.Store
	var created atomic.Bool
	paused, resume := make(chan struct{}), make(chan struct{})
	st, _ = windowsHome(t, func(verb string, _ []string) error {
		switch verb {
		case "/Query":
			if !created.Load() {
				return errors.New("not registered")
			}
		case "/Create":
			if !created.Load() {
				close(paused)
				<-resume
			}
			created.Store(true)
		case "/Run":
			return startDetached(st)
		}
		return nil
	})
	soloNode(t, st, rs.URL)
	fakeTaskClock(t)
	t.Cleanup(func() { daemon.Call(st, daemon.Request{Op: "stop"}, &map[string]bool{}) })
	// pen down's wait for the turn runs on the test clock; it resumes once the paused start is done.
	waiting, startFinished := make(chan struct{}), make(chan struct{})
	old := startLockWaits
	t.Cleanup(func() { startLockWaits = old })
	startLockWaits = func() { close(waiting); <-startFinished }
	startErr := make(chan error, 1)
	go func() { startErr <- startTask(st) }()
	<-paused
	downCode := make(chan int, 1)
	go func() { downCode <- RunDown(nil, io.Discard, io.Discard) }()
	code := -1
	select {
	case <-waiting: // pen down waits for the start's turn
	case code = <-downCode:
	}
	close(resume)
	if err := <-startErr; err != nil {
		t.Fatalf("pen up: %v", err)
	}
	close(startFinished)
	if code == -1 {
		code = <-downCode
	}
	if code != 0 {
		t.Fatalf("pen down exit %d", code)
	}
	var s daemon.Status
	if daemon.Call(st, daemon.Request{Op: "status"}, &s) == nil {
		t.Fatal("pen down reported success, but the node runs after the start it overlapped")
	}
	if _, err := os.Stat(st.Path(downMarker)); err != nil {
		t.Fatalf("no down record after pen down: %v", err)
	}
}

func TestDownDuringServiceStartLeavesTheNodeDown(t *testing.T) {
	for _, osName := range []string{"linux", "darwin"} {
		t.Run(osName, func(t *testing.T) {
			rs := relaytest.New()
			defer rs.Close()
			st, _ := windowsHome(t, func(string, []string) error { return nil })
			serviceOS = osName
			oldFound := serviceManagerFound
			t.Cleanup(func() { serviceManagerFound = oldFound })
			serviceManagerFound = func(string) bool { return true }
			soloNode(t, st, rs.URL)
			fakeTaskClock(t)
			paused, resume := make(chan struct{}), make(chan struct{})
			waiting, finished := make(chan struct{}), make(chan struct{})
			oldWait := startLockWaits
			t.Cleanup(func() { startLockWaits = oldWait })
			startLockWaits = func() { close(waiting); <-finished }
			var running atomic.Bool
			run = func(_ string, args ...string) error {
				cmd := strings.Join(args, " ")
				if cmd == "--user daemon-reload" || strings.HasPrefix(cmd, "enable gui/") {
					close(paused)
					<-resume
				}
				if strings.HasPrefix(cmd, "--user enable --now") || strings.HasPrefix(cmd, "bootstrap ") {
					if err := startDetached(st); err != nil {
						return err
					}
					running.Store(true)
				}
				if cmd == "--user stop pen.service" || strings.HasPrefix(cmd, "bootout ") {
					if running.Swap(false) {
						return daemon.Call(st, daemon.Request{Op: "stop"}, &map[string]bool{})
					}
				}
				return nil
			}
			t.Cleanup(func() { daemon.Call(st, daemon.Request{Op: "stop"}, &map[string]bool{}) })
			up := make(chan int, 1)
			go func() { up <- RunUp(nil, io.Discard, io.Discard) }()
			<-paused
			down := make(chan int, 1)
			go func() { down <- RunDown(nil, io.Discard, io.Discard) }()
			code := -1
			select {
			case <-waiting:
			case code = <-down:
			}
			close(resume)
			upCode := <-up
			close(finished)
			if code == -1 {
				code = <-down
			}
			if upCode != 0 || code != 0 {
				t.Fatalf("up exit %d, down exit %d", upCode, code)
			}
			if running.Load() {
				t.Fatal("pen down reported success but the service runs after the overlapping start")
			}
		})
	}
}

// A starting daemon that takes the control connection but never answers cannot keep the turn: the
// readiness probe has a deadline, so the start fails within its bound and a pen down waiting for the
// turn then runs. The probe's deadline is now (the request still goes out, and the listener has it
// before pen down starts), pen down's wait for the turn holds until the start has returned, and the
// waits run on the test clock.
func TestAStartWhoseDaemonNeverAnswersReleasesTheTurn(t *testing.T) {
	st, _ := windowsHome(t, func(string, []string) error { return nil })
	l, err := net.Listen("unix", daemon.SocketPath(st))
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	asked := make(chan struct{})
	var once sync.Once
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				// Takes the request and never answers.
				if _, err := bufio.NewReader(c).ReadBytes('\n'); err == nil {
					once.Do(func() { close(asked) })
				}
				io.Copy(io.Discard, c)
				c.Close()
			}()
		}
	}()
	fakeTaskClock(t)
	oldProbe := probeTimeout
	t.Cleanup(func() { probeTimeout = oldProbe })
	probeTimeout = 0
	startFinished := make(chan struct{})
	old := startLockWaits
	t.Cleanup(func() { startLockWaits = old })
	startLockWaits = func() { <-startFinished }
	startErr := make(chan error, 1)
	go func() { startErr <- startTask(st) }()
	<-asked // the start holds the turn and waits on a daemon that never answers
	downCode := make(chan int, 1)
	go func() { downCode <- RunDown(nil, io.Discard, io.Discard) }()
	if err := <-startErr; err == nil {
		t.Fatal("a start whose daemon never answers succeeded")
	}
	close(startFinished)
	if code := <-downCode; code != 0 {
		t.Fatalf("pen down exit %d after the start gave up", code)
	}
	if _, err := os.Stat(st.Path(downMarker)); err != nil {
		t.Fatalf("no down record after pen down: %v", err)
	}
}

// pen down does not wait for the task turn without end: past turnWait it fails and names the holder.
func TestDownGivesUpOnATurnThatIsNeverReleasedAndNamesItsHolder(t *testing.T) {
	st, _ := windowsHome(t, func(string, []string) error { return nil })
	fakeTaskClock(t)
	release, err := taskTurn(st, "pen up", io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	var errOut bytes.Buffer
	if code := RunDown(nil, io.Discard, &errOut); code == 0 || !strings.Contains(errOut.String(), fmt.Sprintf("pen up (pid %d)", os.Getpid())) {
		t.Fatalf("pen down exit %d: %q, want a failure naming the holder", code, errOut.String())
	}
	// It said so when it began to wait, not only when it gave up.
	if first, _, _ := strings.Cut(errOut.String(), "\n"); !strings.Contains(first, "waiting for pen up") {
		t.Fatalf("pen down's first line %q does not say it waits for pen up", first)
	}
}

// A leave that outlives pen leave's wait (here held at the daemon's state lock) is not a failed leave:
// the daemon finishes it, pen leave says it is still in progress, and the next pen leave, finding the
// node gone, removes the service and succeeds, for the Windows task and for systemd.
func TestALeaveThatOutlivesItsClientIsFinishedByTheNextLeave(t *testing.T) {
	for _, svc := range []string{"task", "systemd"} {
		t.Run(svc, func(t *testing.T) {
			rs := relaytest.New()
			defer rs.Close()
			var st *state.Store
			var removed func() bool
			if svc == "task" {
				var calls *[]string
				st, calls = windowsHome(t, func(string, []string) error { return nil })
				removed = func() bool {
					return slices.ContainsFunc(*calls, func(c string) bool { return strings.Contains(c, "/Delete") })
				}
			} else {
				home, calls := fakeSystemd(t)
				t.Setenv("PEN_TEST_MAIN", "1")
				t.Setenv("PEN_HOSTKEYS", "none")
				t.Setenv("PEN_SSH_DIR", filepath.Join(home, "ssh"))
				var err error
				if st, err = openState(); err != nil {
					t.Fatal(err)
				}
				removed = func() bool {
					_, err := os.Stat(unitPath())
					return errors.Is(err, os.ErrNotExist) && slices.ContainsFunc(*calls, func(c serviceCall) bool { return strings.Contains(c.cmd, "disable --now") })
				}
			}
			soloNode(t, st, rs.URL)
			if err := startDetached(st); err != nil {
				t.Fatal(err)
			}
			var s daemon.Status
			if err := daemon.Call(st, daemon.Request{Op: "status"}, &s); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { daemon.Call(st, daemon.Request{Op: "stop"}, &map[string]bool{}) })
			old := leaveTimeout
			t.Cleanup(func() { leaveTimeout = old })
			leaveTimeout = 0
			unlock, err := st.Lock() // the daemon's leave waits here, after its revoke is signed
			if err != nil {
				t.Fatal(err)
			}
			var out, errOut bytes.Buffer
			code := RunLeave(nil, &out, &errOut)
			unlock()
			if code == 0 || !strings.Contains(errOut.String(), "still in progress") || removed() {
				t.Fatalf("first pen leave: exit %d, %q, service removed %v; want an unfinished leave that keeps the service", code, errOut.String(), removed())
			}
			if !waitExit(s.PID, downWait) {
				t.Fatal("the daemon did not finish its leave and stop")
			}
			if _, err := os.Stat(st.Path(daemon.LeftMarker)); err != nil {
				t.Fatalf("the daemon did not leave: %v", err)
			}
			out.Reset()
			errOut.Reset()
			if code := RunLeave(nil, &out, &errOut); code != 0 || !removed() {
				t.Fatalf("second pen leave: exit %d (%q %q), service removed %v; want it to finish the cleanup", code, out.String(), errOut.String(), removed())
			}
		})
	}
}

// pen up on Windows takes the task turn before it touches the down record or answers from a running
// daemon: while a pen down holds the turn, pen up waits for it, then starts the node again (it runs last).
func TestUpWaitsForAPenDownThatHoldsTheTurn(t *testing.T) {
	rs := relaytest.New()
	defer rs.Close()
	var st *state.Store
	st, _ = windowsHome(t, func(verb string, _ []string) error {
		if verb == "/Run" {
			return startDetached(st)
		}
		return nil
	})
	soloNode(t, st, rs.URL)
	if err := startDetached(st); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { daemon.Call(st, daemon.Request{Op: "stop"}, &map[string]bool{}) })
	fakeTaskClock(t)
	release, err := taskTurn(st, "pen down", io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.WriteAtomic(downMarker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	waiting, downDone := make(chan struct{}), make(chan struct{})
	old := startLockWaits
	t.Cleanup(func() { startLockWaits = old })
	startLockWaits = func() { close(waiting); <-downDone }
	upCode := make(chan int, 1)
	go func() { upCode <- RunUp(nil, io.Discard, io.Discard) }()
	select {
	case <-waiting:
	case code := <-upCode:
		_, err := os.Stat(st.Path(downMarker))
		release()
		t.Fatalf("pen up returned %d while pen down held the turn (down record: %v)", code, err)
	}
	// As pen down: stop the node inside the turn, then hand the turn over.
	if err := stopTaskInTurn(st); err != nil {
		t.Fatal(err)
	}
	release()
	close(downDone)
	if code := <-upCode; code != 0 {
		t.Fatalf("pen up exit %d", code)
	}
	var s daemon.Status
	if daemon.Call(st, daemon.Request{Op: "status"}, &s) != nil {
		t.Fatal("pen up ran last but the node does not run")
	}
	if _, err := os.Stat(st.Path(downMarker)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("pen up ran last but the down record stays: %v", err)
	}
}

// A leave whose deletion of identity.json failed (here a folder in its place) left the left marker
// behind; once the daemon is gone, pen leave must not trust the marker: it deletes what is left, under
// the state lock, and succeeds only when the identity is gone; until then it names the file and keeps
// the service.
func TestAResumedLeaveDeletesWhatTheLeaveCouldNot(t *testing.T) {
	rs := relaytest.New()
	defer rs.Close()
	st, calls := windowsHome(t, func(string, []string) error { return nil })
	deleted := func() bool {
		return slices.ContainsFunc(*calls, func(c string) bool { return strings.Contains(c, "/Delete") })
	}
	soloNode(t, st, rs.URL)
	if err := startDetached(st); err != nil {
		t.Fatal(err)
	}
	var s daemon.Status
	if err := daemon.Call(st, daemon.Request{Op: "status"}, &s); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { daemon.Call(st, daemon.Request{Op: "stop"}, &map[string]bool{}) })
	// The obstruction: identity.json becomes a folder that is not empty, so removing it fails.
	idPath := st.Path("identity.json")
	if err := os.Remove(idPath); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(idPath, "held"), 0o700); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	if code := RunLeave(nil, &out, &errOut); code == 0 || !strings.Contains(errOut.String(), "identity.json") || deleted() {
		t.Fatalf("leave with an undeletable identity: exit %d, %q, task deleted %v", code, errOut.String(), deleted())
	}
	if _, err := os.Stat(st.Path(daemon.LeftMarker)); err != nil {
		t.Fatalf("the leave did not get as far as the left marker: %v", err)
	}
	daemon.Call(st, daemon.Request{Op: "stop"}, &map[string]bool{})
	if !waitExit(s.PID, downWait) {
		t.Fatal("the daemon did not stop")
	}
	out.Reset()
	errOut.Reset()
	if code := RunLeave(nil, &out, &errOut); code == 0 || !strings.Contains(errOut.String(), "identity.json") || deleted() {
		t.Fatalf("resumed leave while the identity stays: exit %d, %q %q, task deleted %v", code, out.String(), errOut.String(), deleted())
	}
	if err := os.Remove(filepath.Join(idPath, "held")); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	errOut.Reset()
	if code := RunLeave(nil, &out, &errOut); code != 0 || !deleted() {
		t.Fatalf("resumed leave: exit %d, %q %q, task deleted %v", code, out.String(), errOut.String(), deleted())
	}
	if _, err := os.Stat(idPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("pen leave succeeded but identity.json stays: %v", err)
	}
}

// A resumed pen leave that saw the left marker, then paused while a pen join on the same machine made a
// new identity and mesh, must not delete them: the deletion checks the marker under the state lock, and
// pen leave says this node is not leaving.
func TestAResumedLeaveDoesNotDeleteANodeJoinedMeanwhile(t *testing.T) {
	rs := relaytest.New()
	defer rs.Close()
	st, calls := windowsHome(t, func(string, []string) error { return nil })
	soloNode(t, st, rs.URL)
	if err := st.WriteAtomic(daemon.LeftMarker, nil, 0o600); err != nil { // a leave that stopped part way
		t.Fatal(err)
	}
	var joined []byte
	old := leaveResumes
	t.Cleanup(func() { leaveResumes = old })
	leaveResumes = func() {
		// What pen join does up to its saved identity and mesh: a new node in this folder.
		os.Remove(st.Path("identity.json"))
		os.Remove(st.Path("mesh.json"))
		id, _, err := st.EnsureIdentityClearing(daemon.LeftMarker)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := mesh.Found(st, id, "b", 2); err != nil {
			t.Fatal(err)
		}
		joined, _ = os.ReadFile(st.Path("identity.json"))
	}
	var out, errOut bytes.Buffer
	code := RunLeave(nil, &out, &errOut)
	now, _ := os.ReadFile(st.Path("identity.json"))
	if len(joined) == 0 || !bytes.Equal(now, joined) {
		t.Fatalf("pen leave (exit %d, %q %q) deleted the identity of the node joined meanwhile", code, out.String(), errOut.String())
	}
	if _, err := os.Stat(st.Path("mesh.json")); err != nil {
		t.Fatalf("pen leave deleted the mesh joined meanwhile: %v", err)
	}
	if code == 0 || !strings.Contains(errOut.String(), "not leaving") || slices.ContainsFunc(*calls, func(c string) bool { return strings.Contains(c, "/Delete") }) {
		t.Fatalf("pen leave: exit %d, %q, calls %q; want it to say the node is not leaving and keep the task", code, errOut.String(), *calls)
	}
}

// A resumed pen leave that saw the left marker, while a pen join cleared it and made a new node before
// the leave decided, keeps the service: the leave decides once, under the state lock.
func TestAResumedLeaveKeepsTheServiceOfANodeJoinedBeforeItDecided(t *testing.T) {
	rs := relaytest.New()
	defer rs.Close()
	st, calls := windowsHome(t, func(string, []string) error { return nil })
	soloNode(t, st, rs.URL)
	if err := st.WriteAtomic(daemon.LeftMarker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	old := leaveDecides
	t.Cleanup(func() { leaveDecides = old })
	leaveDecides = func() {
		os.Remove(st.Path("identity.json"))
		os.Remove(st.Path("mesh.json"))
		id, _, err := st.EnsureIdentityClearing(daemon.LeftMarker)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := mesh.Found(st, id, "b", 2); err != nil {
			t.Fatal(err)
		}
	}
	var out, errOut bytes.Buffer
	code := RunLeave(nil, &out, &errOut)
	if code == 0 || !strings.Contains(errOut.String(), "not leaving") || slices.ContainsFunc(*calls, func(c string) bool { return strings.Contains(c, "/Delete") }) {
		t.Fatalf("pen leave: exit %d, %q %q, calls %q; want it to say the node is not leaving and keep the task", code, out.String(), errOut.String(), *calls)
	}
	if _, err := os.Stat(st.Path("identity.json")); err != nil {
		t.Fatalf("pen leave deleted the node joined meanwhile: %v", err)
	}
}

// A daemon that holds daemon.lock but does not answer on the control socket does its own leave: a
// resumed pen leave refuses to delete anything under it.
func TestAResumedLeaveRefusesWhileADaemonHoldsItsLock(t *testing.T) {
	rs := relaytest.New()
	defer rs.Close()
	st, _ := windowsHome(t, func(string, []string) error { return nil })
	soloNode(t, st, rs.URL)
	if err := st.WriteAtomic(daemon.LeftMarker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	release, err := state.TryLock(st.Path("daemon.lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	var out, errOut bytes.Buffer
	if code := RunLeave(nil, &out, &errOut); code == 0 || !strings.Contains(errOut.String(), "daemon.lock") {
		t.Fatalf("pen leave: exit %d, %q %q; want a refusal naming daemon.lock", code, out.String(), errOut.String())
	}
	if _, err := os.Stat(st.Path("identity.json")); err != nil {
		t.Fatalf("pen leave deleted files under a running daemon: %v", err)
	}
}

// A daemon.lock that cannot be opened as a file (a folder) makes the daemon's state unknown, so a
// resumed pen leave must not delete anything under it.
func TestAResumedLeaveRefusesWhenDaemonLockCannotBeChecked(t *testing.T) {
	rs := relaytest.New()
	defer rs.Close()
	st, calls := windowsHome(t, func(string, []string) error { return nil })
	soloNode(t, st, rs.URL)
	if err := st.WriteAtomic(daemon.LeftMarker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	lockPath := st.Path("daemon.lock")
	if err := os.Remove(lockPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	if err := os.Mkdir(lockPath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(lockPath, "held"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	if code := RunLeave(nil, &out, &errOut); code == 0 || !strings.Contains(errOut.String(), "daemon.lock") {
		t.Fatalf("pen leave: exit %d, %q %q; want a refusal naming daemon.lock", code, out.String(), errOut.String())
	}
	if _, err := os.Stat(st.Path("identity.json")); err != nil {
		t.Fatalf("pen leave deleted files when daemon.lock could not be checked: %v", err)
	}
	if slices.ContainsFunc(*calls, func(c string) bool { return strings.Contains(c, "/Delete") }) {
		t.Fatalf("pen leave deleted the task when daemon.lock could not be checked: %q", *calls)
	}
}
