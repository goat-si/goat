package cli

import (
	"fmt"
	"io"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
)

// downWait bounds how long pen down waits for the daemon process to exit after it acknowledged stop.
const downWait = 10 * time.Second

// RunDown stops the daemon (and its service, if one is installed).
func RunDown(args []string, stdout, stderr io.Writer) int {
	if _, err := parse(newFlags("down", stderr), args); err != nil {
		return 2
	}
	st, err := openState()
	if err != nil {
		return fail(stderr, err)
	}
	if taskTurnApplies() {
		// Before looking for a task or a daemon: a pen up holding the turn may be registering the task.
		// The down record stays even when nothing runs, so a start that is already deciding sees it.
		release, err := taskTurn(st, "pen down", stderr)
		if err != nil {
			return fail(stderr, err)
		}
		defer release()
		if err := st.WriteAtomic(downMarker, nil, 0o600); err != nil {
			return fail(stderr, err)
		}
	}
	if mode := installedService(st); mode != "none" {
		if err := stopService(mode, st); err != nil {
			return fail(stderr, err)
		}
		fmt.Fprintln(stdout, "stopped the pen service")
		return 0
	}
	cl, err := daemon.Dial(st)
	if err != nil {
		fmt.Fprintln(stdout, "pen is not running")
		return 0
	}
	defer cl.Close()
	var s daemon.Status
	if err := daemon.CallWithin(st, daemon.Request{Op: "status"}, &s, probeTimeout); err != nil {
		return fail(stderr, err)
	}
	var ok map[string]bool
	if err := cl.SetDeadline(time.Now().Add(probeTimeout)); err != nil {
		return fail(stderr, err)
	}
	if err := cl.Send(daemon.Request{Op: "stop"}); err != nil {
		return fail(stderr, err)
	}
	if err := cl.Next(&ok); err != nil {
		return fail(stderr, err)
	}
	// The daemon still writes its state while it shuts down; scripts remove or replace files right after.
	if !waitExit(s.PID, downWait) {
		fmt.Fprintf(stdout, "pen is still stopping (pid %d)\n", s.PID)
		return 0
	}
	fmt.Fprintln(stdout, "stopped pen")
	return 0
}
