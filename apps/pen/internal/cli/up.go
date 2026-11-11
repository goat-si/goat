package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

const readyTimeout = 20 * time.Second

// RunUp creates the identity and mesh if needed and starts the daemon.
func RunUp(args []string, stdout, stderr io.Writer) int {
	fs := newFlags("up", stderr)
	var relayURLs multiFlag
	fs.Var(&relayURLs, "relay", "relay URL (https://...); repeat for several relays")
	name := fs.String("name", "", "this node's name")
	foreground := fs.Bool("foreground", false, "run the daemon in this process")
	service := fs.Bool("service", false, "internal: for the systemd and launchd service and the Windows task's daemon; a start it refuses exits 0, so the caller cannot tell it failed")
	noService := fs.Bool("no-service", false, "never install a service (systemd, launchd or a Windows logon task)")
	spawnDaemon := fs.Bool("spawn-daemon", false, "internal: start the daemon detached, print its pid and exit")
	supervise := fs.Bool("supervise", false, "internal: the Windows logon task's action; runs the daemon and restarts it after a crash")
	if _, err := parse(fs, args); err != nil {
		return 2
	}
	st, err := openState()
	if err != nil {
		return fail(stderr, err)
	}
	if *spawnDaemon {
		return spawnDetached(st, stdout, stderr)
	}
	if !*foreground && !*supervise && taskTurnApplies() {
		// Before ending a pen down or answering from a running daemon: a pen down holding the turn
		// finishes first, and the service start below runs in this turn.
		release, err := taskTurn(st, "pen up", stderr)
		if err != nil {
			return fail(stderr, err)
		}
		defer release()
	}
	// refused ends a start pen up cannot make: the service exits 0, since its manager restarts
	// only a failure and nothing changes between restarts; everyone else sees the failure. The
	// Windows task's supervisor is a service start too.
	asService := *service || *supervise || startedByService()
	// The start this service start serves: the supervisor reads the id pen up wrote before it checks
	// anything, and hands it to the daemon it runs.
	req := os.Getenv("PEN_START_REQUEST")
	if *supervise {
		req = startRequestOf(st)
	}
	refused := func(err error) int {
		if (*foreground || *supervise) && asService {
			noteRefused(st, req, *supervise, err, stderr)
			return 0
		}
		return fail(stderr, err)
	}
	if *foreground || *supervise {
		// A service manager restarting the daemon after pen leave must not mint a new node.
		if _, err := os.Stat(st.Path(daemon.LeftMarker)); err == nil {
			return refused(errors.New("this node left its mesh; run pen up or pen join to start again"))
		}
	} else if err := os.Remove(st.Path(downMarker)); err != nil && !errors.Is(err, os.ErrNotExist) {
		// A person starting Pen ends a pen down, also when Pen then runs without the service.
		return fail(stderr, err)
	}
	// A person's pen up starts the node again: the left marker goes in the same state-lock hold that
	// makes the identity, so a resumed pen leave (FinishLeave) cannot delete the new node's files.
	leftMarker := daemon.LeftMarker
	if *foreground || *supervise {
		leftMarker = "" // a service start refuses on the marker above and never clears it
	}
	id, _, err := st.EnsureIdentityClearing(leftMarker)
	if err != nil {
		return fail(stderr, err)
	}
	cfg, err := startConfig(st, relayURLs, *name)
	if errors.Is(err, errNoRelay) {
		return refused(errors.New("no relay configured; run pen up --relay https://<relay>"))
	}
	if err != nil {
		return fail(stderr, err)
	}
	if err := daemon.CheckConfig(cfg); err != nil {
		return refused(err)
	}
	if _, err := mesh.Load(st); errors.Is(err, os.ErrNotExist) {
		if _, err := mesh.FoundV(mesh.EpochShared, st, id, cfg.Name, time.Now().UnixMilli()); err != nil {
			return fail(stderr, err)
		}
	} else if err != nil {
		return fail(stderr, err)
	}

	if *supervise {
		return runSupervised(st, stderr, req)
	}
	if *foreground {
		return runForeground(st, stderr)
	}
	var s daemon.Status
	if err := daemon.CallWithin(st, daemon.Request{Op: "status"}, &s, probeTimeout); err == nil {
		if s.Name != cfg.Name {
			daemon.CallWithin(st, daemon.Request{Op: "name", Name: cfg.Name}, &s, opTimeout)
		}
		if s.Uplink == "replaced" || !sameRelays(s.Relays, cfg.RelayList()) {
			daemon.CallWithin(st, daemon.Request{Op: "reconnect"}, &s, opTimeout)
		}
		printStatus(stdout, s)
		return 0
	}
	mode := serviceMode(*noService, st)
	if mode == "none" {
		err = startDetached(st)
	} else {
		err = startService(mode, st)
	}
	if err != nil {
		return fail(stderr, err)
	}
	if err := daemon.CallWithin(st, daemon.Request{Op: "status"}, &s, probeTimeout); err != nil {
		return fail(stderr, err)
	}
	printStatus(stdout, s)
	return 0
}

// startedByService reports whether systemd (248 and later set SYSTEMD_EXEC_PID to the pid they
// started) or launchd (XPC_SERVICE_NAME is the job's label) started this process: units written
// before --service run plain --foreground and must not restart a refused start either.
func startedByService() bool {
	return os.Getenv("SYSTEMD_EXEC_PID") == strconv.Itoa(os.Getpid()) || os.Getenv("XPC_SERVICE_NAME") == launchdLabel
}

func printStatus(w io.Writer, s daemon.Status) {
	fmt.Fprintf(w, "node         %s (%s)\n", s.NodeID, s.Name)
	fmt.Fprintf(w, "fingerprint  %s\n", s.Fingerprint)
	for _, r := range s.Relays {
		fmt.Fprintf(w, "relay        %s (uplink %s)\n", r.URL, r.Uplink)
	}
	fmt.Fprintf(w, "mesh         %s, %d member(s)\n", s.MeshID, s.Members)
}

func runForeground(st *state.Store, stderr io.Writer) int {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	opt := daemonOptions(st)
	if ready := readyFile(); ready != nil {
		opt.Ready = func() {
			ready.WriteString("ready\n")
			ready.Close()
		}
	}
	d, err := daemon.New(opt)
	if err != nil {
		return fail(stderr, err)
	}
	if err := d.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		return fail(stderr, err)
	}
	return 0
}

// readyFile is the ready pipe the starting pen up handed down (fd 3, or a handle on Windows).
func readyFile() *os.File {
	n, err := strconv.ParseUint(os.Getenv("PEN_READY_FD"), 10, 64)
	if err != nil {
		return nil
	}
	return os.NewFile(uintptr(n), "ready")
}

// startDetached starts the daemon through "pen up --spawn-daemon", which exits once the daemon runs, so the
// daemon is owned by init from the start and a kill of this command's process tree does not reach it.
// The ready pipe passes through to the daemon.
func startDetached(st *state.Store) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	logf, err := os.OpenFile(st.Path("daemon.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer logf.Close()
	r, w, err := os.Pipe()
	if err != nil {
		return err
	}
	defer r.Close()
	var out []byte
	err = startDetachedCmd(func() *exec.Cmd {
		cmd := exec.Command(exe, "up", "--spawn-daemon")
		cmd.Env = append(os.Environ(), "PEN_HOME="+st.Dir)
		cmd.Stderr = logf
		return cmd
	}, w, func(cmd *exec.Cmd) (err error) {
		out, err = cmd.Output()
		return err
	})
	w.Close()
	if err != nil {
		return fmt.Errorf("could not start the daemon (%v); see %s", err, st.Path("daemon.log"))
	}
	pid := strings.TrimSpace(string(out))
	line := make(chan string, 1)
	go func() {
		s, _ := bufio.NewReader(r).ReadString('\n')
		line <- s
	}()
	select {
	case s := <-line:
		if s != "ready\n" {
			return fmt.Errorf("the daemon (pid %s) exited during start; see %s", pid, st.Path("daemon.log"))
		}
	case <-time.After(readyTimeout):
		return fmt.Errorf("the daemon (pid %s) did not report ready within %v; see %s", pid, readyTimeout, st.Path("daemon.log"))
	}
	return nil
}

// spawnDetached is "pen up --spawn-daemon": it starts "pen up --foreground" in its own session with the
// inherited ready pipe, prints the daemon's pid and returns without waiting for it.
func spawnDetached(st *state.Store, stdout, stderr io.Writer) int {
	exe, err := os.Executable()
	if err != nil {
		return fail(stderr, err)
	}
	logf, err := os.OpenFile(st.Path("daemon.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return fail(stderr, err)
	}
	defer logf.Close()
	ready := readyFile()
	if ready == nil {
		return fail(stderr, errors.New("--spawn-daemon needs the ready pipe pen up passes"))
	}
	var cmd *exec.Cmd
	err = startDetachedCmd(func() *exec.Cmd {
		cmd = exec.Command(exe, "up", "--foreground")
		cmd.Env = append(os.Environ(), "PEN_HOME="+st.Dir)
		cmd.Stdout, cmd.Stderr = logf, logf
		return cmd
	}, ready, (*exec.Cmd).Start)
	if err != nil {
		return fail(stderr, err)
	}
	fmt.Fprintln(stdout, cmd.Process.Pid)
	if err := cmd.Process.Release(); err != nil {
		return fail(stderr, err)
	}
	return 0
}

// waitControl waits for a service-started daemon to answer on its control socket.
func waitControl(st *state.Store) error {
	deadline := time.Now().Add(readyTimeout)
	for {
		var s daemon.Status
		if err := daemon.CallWithin(st, daemon.Request{Op: "status"}, &s, probeTimeout); err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("the pen service did not answer within %v", readyTimeout)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// multiFlag collects a repeatable string flag.
type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

func sameRelays(states []daemon.RelayState, want []string) bool {
	if len(states) != len(want) {
		return false
	}
	for i, r := range states {
		if r.URL != want[i] {
			return false
		}
	}
	return true
}
