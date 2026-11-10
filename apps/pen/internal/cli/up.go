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
	"github.com/goat-si/goat/apps/pen/internal/ident"
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
	noService := fs.Bool("no-service", false, "never install a systemd or launchd service")
	spawnDaemon := fs.Bool("spawn-daemon", false, "internal: start the daemon detached, print its pid and exit")
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
	if *foreground {
		// A service manager restarting the daemon after pen leave must not mint a new node.
		if _, err := os.Stat(st.Path(daemon.LeftMarker)); err == nil {
			fmt.Fprintln(stderr, "pen: this node left its mesh; run pen up or pen join to start again")
			return 0
		}
	} else if err := clearLeft(st); err != nil {
		return fail(stderr, err)
	}
	id, _, err := st.EnsureIdentity()
	if err != nil {
		return fail(stderr, err)
	}
	cfg, err := st.LoadConfig()
	if err != nil {
		return fail(stderr, err)
	}
	if len(relayURLs) > 0 {
		var list []string
		for _, u := range relayURLs {
			list = append(list, strings.TrimRight(u, "/"))
		}
		if err := daemon.ValidRelays(list); err != nil {
			return fail(stderr, err)
		}
		cfg.SetRelays(list)
	}
	if len(cfg.RelayList()) == 0 {
		return fail(stderr, errors.New("no relay configured; pass --relay https://<relay>"))
	}
	if *name != "" {
		cfg.Name = *name
	}
	if cfg.Name == "" {
		cfg.Name = defaultName()
	}
	if !ident.ValidName(cfg.Name) {
		return fail(stderr, fmt.Errorf("invalid name %q (1-32 of a-z 0-9 - _ ., starting with a letter or digit)", cfg.Name))
	}
	if err := st.SaveConfig(cfg); err != nil {
		return fail(stderr, err)
	}
	if _, err := mesh.Load(st); errors.Is(err, os.ErrNotExist) {
		if _, err := mesh.Found(st, id, cfg.Name, time.Now().UnixMilli()); err != nil {
			return fail(stderr, err)
		}
	} else if err != nil {
		return fail(stderr, err)
	}

	if *foreground {
		return runForeground(st, stderr)
	}
	var s daemon.Status
	if err := daemon.Call(st, daemon.Request{Op: "status"}, &s); err == nil {
		if s.Name != cfg.Name {
			daemon.Call(st, daemon.Request{Op: "name", Name: cfg.Name}, &s)
		}
		if s.Uplink == "replaced" || !sameRelays(s.Relays, cfg.RelayList()) {
			daemon.Call(st, daemon.Request{Op: "reconnect"}, &s)
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
	if err := daemon.Call(st, daemon.Request{Op: "status"}, &s); err != nil {
		return fail(stderr, err)
	}
	printStatus(stdout, s)
	return 0
}

// clearLeft removes the leave marker: pen up and pen join, run by a person, start the node again.
func clearLeft(st *state.Store) error {
	if err := os.Remove(st.Path(daemon.LeftMarker)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
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
		if err := daemon.Call(st, daemon.Request{Op: "status"}, &s); err == nil {
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
