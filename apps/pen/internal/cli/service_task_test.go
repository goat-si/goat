package cli

import (
	"bytes"
	"encoding/binary"
	"encoding/xml"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
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
	run = func(name string, args ...string) error {
		*calls = append(*calls, name+" "+strings.Join(args, " "))
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
	def := parseTask(t, utf16File(renderTask(exe, account)))
	if def.Command != exe || def.User != account || def.LogonUser != account {
		t.Fatalf("task definition %+v", def)
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
	old := runRetry
	runRetry = 300 * time.Millisecond
	defer func() { runRetry = old }()
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
