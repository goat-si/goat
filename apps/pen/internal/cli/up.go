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
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

const readyTimeout = 20 * time.Second

// RunUp creates the identity and mesh if needed and starts the daemon.
func RunUp(args []string, stdout, stderr io.Writer) int {
	fs := newFlags("up", stderr)
	relayURL := fs.String("relay", "", "relay URL (https://...)")
	name := fs.String("name", "", "this node's name")
	foreground := fs.Bool("foreground", false, "run the daemon in this process")
	noService := fs.Bool("no-service", false, "never install a systemd or launchd service")
	if _, err := parse(fs, args); err != nil {
		return 2
	}
	st, err := openState()
	if err != nil {
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
	if *relayURL != "" {
		if _, err := wire.RelayOrigin(*relayURL); err != nil {
			return fail(stderr, err)
		}
		cfg.Relay = strings.TrimRight(*relayURL, "/")
	}
	if cfg.Relay == "" {
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
		if s.Uplink == "replaced" || s.Relay != cfg.Relay {
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

func printStatus(w io.Writer, s daemon.Status) {
	fmt.Fprintf(w, "node         %s (%s)\n", s.NodeID, s.Name)
	fmt.Fprintf(w, "fingerprint  %s\n", s.Fingerprint)
	fmt.Fprintf(w, "relay        %s (uplink %s)\n", s.Relay, s.Uplink)
	fmt.Fprintf(w, "mesh         %s, %d member(s)\n", s.MeshID, s.Members)
}

func runForeground(st *state.Store, stderr io.Writer) int {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	opt := daemonOptions(st)
	if fd := os.Getenv("PEN_READY_FD"); fd != "" {
		n, _ := strconv.Atoi(fd)
		ready := os.NewFile(uintptr(n), "ready")
		opt.Ready = func() {
			if ready != nil {
				ready.WriteString("ready\n")
				ready.Close()
			}
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

// startDetached runs "pen up --foreground" in a new session and waits for its ready line.
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
	cmd := exec.Command(exe, "up", "--foreground")
	cmd.Env = append(os.Environ(), "PEN_HOME="+st.Dir, "PEN_READY_FD=3")
	cmd.ExtraFiles = []*os.File{w}
	cmd.Stdout, cmd.Stderr = logf, logf
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		w.Close()
		return err
	}
	w.Close()
	line := make(chan string, 1)
	go func() {
		s, _ := bufio.NewReader(r).ReadString('\n')
		line <- s
	}()
	select {
	case s := <-line:
		if s != "ready\n" {
			cmd.Wait()
			return fmt.Errorf("the daemon exited during start; see %s", st.Path("daemon.log"))
		}
	case <-time.After(readyTimeout):
		return fmt.Errorf("the daemon did not report ready within %v; see %s", readyTimeout, st.Path("daemon.log"))
	}
	return cmd.Process.Release()
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
