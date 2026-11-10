package cli

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"os/user"
	"runtime/debug"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

// On Windows the service is a Task Scheduler task that starts "pen up --supervise" at the user's logon,
// with the user's interactive token: registering one needs no admin rights, and it runs only while the
// user is signed in. The task's restart-on-failure covers launch failures only, not a non-zero exit, so
// the supervisor restarts a daemon that crashed.

// currentAccount is the signed-in account, MACHINE\name or DOMAIN\name (a seam for tests).
var currentAccount = func() (string, error) {
	u, err := user.Current()
	if err != nil {
		return "", err
	}
	return u.Username, nil
}

// taskName is "pen-<short name>-<hash>": task names are machine-wide, and the hash of the full account
// keeps two accounts with the same short name apart.
func taskName(account string) string {
	var b strings.Builder
	dash := false
	for _, c := range strings.ToLower(account[strings.LastIndex(account, `\`)+1:]) {
		if c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-' {
			b.WriteRune(c)
			dash = false
		} else if !dash {
			b.WriteByte('-')
			dash = true
		}
	}
	sum := sha256.Sum256([]byte(strings.ToLower(account)))
	return "pen-" + b.String() + "-" + hex.EncodeToString(sum[:4])
}

func accountTaskName() (string, error) {
	account, err := currentAccount()
	if err != nil {
		return "", err
	}
	return taskName(account), nil
}

func renderTask(exe, account string) string {
	esc := func(s string) string {
		var b bytes.Buffer
		xml.EscapeText(&b, []byte(s))
		return b.String()
	}
	return strings.NewReplacer("__PEN__", esc(exe), "__USER__", esc(account)).Replace(TaskXML)
}

// utf16File is s as UTF-16LE with a byte order mark: schtasks /XML refuses UTF-8 ("cannot switch encoding").
func utf16File(s string) []byte {
	u := utf16.Encode([]rune(s))
	b := make([]byte, 2+2*len(u))
	b[0], b[1] = 0xff, 0xfe
	for i, v := range u {
		binary.LittleEndian.PutUint16(b[2+2*i:], v)
	}
	return b
}

// startTask registers (or replaces) the logon task and starts it now.
func startTask(st *state.Store) error {
	account, err := currentAccount()
	if err != nil {
		return err
	}
	exe, err := exePath()
	if err != nil {
		return err
	}
	name := taskName(account)
	path := st.Path(".pen-task.xml")
	if err := os.WriteFile(path, utf16File(renderTask(exe, account)), 0o600); err != nil {
		return err
	}
	defer os.Remove(path)
	if err := run("schtasks", "/Create", "/TN", name, "/XML", path, "/F"); err != nil {
		return err
	}
	if err := os.Remove(st.Path(downMarker)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return run("schtasks", "/Run", "/TN", name)
}

// downMarker tells the supervisor that pen down stopped the daemon, so an exit of any status ends it
// instead of a restart. pen up and the next supervisor start remove it.
const downMarker = "down"

// supervisorLock is held by the running supervisor; pen down waits for it to come free.
const supervisorLock = "supervisor.lock"

// supervisorWait bounds how long pen down waits for the supervisor to end (a seam for tests).
var supervisorWait = downWait

// stopTask stops the daemon through its control socket and waits until the supervisor, and so the task,
// has ended: an immediate pen up's schtasks /Run would otherwise meet the old run and be dropped
// (IgnoreNew). The task stays registered and starts again at the next logon. schtasks /End is the
// fallback for a daemon or supervisor that does not end.
func stopTask(st *state.Store) error {
	if err := st.WriteAtomic(downMarker, nil, 0o600); err != nil {
		return err
	}
	var s daemon.Status
	if daemon.Call(st, daemon.Request{Op: "status"}, &s) == nil {
		// A daemon that is already shutting down (pen leave) may close the socket before it answers.
		daemon.Call(st, daemon.Request{Op: "stop"}, &map[string]bool{})
		waitExit(s.PID, downWait)
	}
	if supervisorGone(st, supervisorWait) {
		return nil
	}
	name, err := accountTaskName()
	if err != nil {
		return err
	}
	endErr := run("schtasks", "/End", "/TN", name)
	if supervisorGone(st, 0) {
		return nil
	}
	if endErr != nil {
		return fmt.Errorf("the pen task %s did not stop: %w", name, endErr)
	}
	return fmt.Errorf("the pen task %s did not stop", name)
}

// supervisorGone reports whether no supervisor holds its lock, waiting up to d for it to end.
func supervisorGone(st *state.Store, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for {
		release, err := state.TryLock(st.Path(supervisorLock))
		if err == nil {
			release()
			return true
		}
		if !errors.Is(err, state.ErrLocked) || !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func removeTask(st *state.Store) error {
	if err := stopTask(st); err != nil {
		return err
	}
	name, err := accountTaskName()
	if err != nil {
		return err
	}
	return run("schtasks", "/Delete", "/TN", name, "/F")
}

// runSupervised is "pen up --supervise", the task's action: it drops the console window the task gave
// it, runs the daemon as a windowless child that logs to daemon.log, and starts it again after a crash.
func runSupervised(st *state.Store, stderr io.Writer) int {
	logf, err := os.OpenFile(st.Path("daemon.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return fail(stderr, err)
	}
	defer logf.Close()
	detachConsole()
	debug.SetCrashOutput(logf, debug.CrashOptions{})
	logger := log.New(logf, "", log.LstdFlags)
	release, err := state.TryLock(st.Path(supervisorLock))
	if errors.Is(err, state.ErrLocked) {
		logger.Print("pen supervisor: another one is running")
		return 0
	}
	if err != nil {
		logger.Printf("pen supervisor: %v", err)
		return 1
	}
	defer release()
	if err := os.Remove(st.Path(downMarker)); err != nil && !errors.Is(err, os.ErrNotExist) {
		logger.Printf("pen supervisor: %v", err)
	}
	stopRequested := func() bool {
		_, err := os.Stat(st.Path(downMarker))
		return err == nil
	}
	exe, err := exePath()
	if err != nil {
		logger.Print(err)
		return 1
	}
	return superviseLoop(func() int {
		cmd := exec.Command(exe, "up", "--foreground")
		cmd.Stdout, cmd.Stderr = logf, logf
		hideWindow(cmd)
		err := cmd.Run()
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return exit.ExitCode()
		}
		if err != nil {
			logger.Printf("pen supervisor: %v", err)
			return -1
		}
		return 0
	}, stopRequested, time.Sleep, time.Now, logger.Printf)
}

const restartFirst, restartMax = 2 * time.Second, time.Minute

// superviseLoop runs the daemon until it exits 0 (pen down, pen leave, the left marker) or pen down asked
// for the stop (stopRequested). After any other exit it waits 2 s, doubling up to 1 min while the daemon
// keeps failing fast, as systemd's Restart=on-failure and launchd's KeepAlive do on unix.
func superviseLoop(run func() int, stopRequested func() bool, wait func(time.Duration), now func() time.Time, logf func(string, ...any)) int {
	backoff := restartFirst
	for {
		began := now()
		code := run()
		if code == 0 || stopRequested() {
			return 0
		}
		if now().Sub(began) >= restartMax {
			backoff = restartFirst
		}
		logf("pen daemon exited with status %d; starting it again in %v", code, backoff)
		wait(backoff)
		if stopRequested() {
			return 0
		}
		backoff = min(2*backoff, restartMax)
	}
}
