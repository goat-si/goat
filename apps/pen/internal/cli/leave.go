package cli

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

// RunLeave revokes this node's own key, pushes it, stops the daemon and deletes the keys.
func RunLeave(args []string, stdout, stderr io.Writer) int {
	if _, err := parse(newFlags("leave", stderr), args); err != nil {
		return 2
	}
	st, err := openState()
	if err != nil {
		return fail(stderr, err)
	}
	if taskTurnApplies() {
		// As pen down: take the turn before looking for the task, so a start in flight finishes first.
		release, err := taskTurn(st, "pen leave")
		if err != nil {
			return fail(stderr, err)
		}
		defer release()
	}
	mode := installedService(st)
	var res struct{ Results []daemon.PushResult }
	err = daemon.CallWithin(st, daemon.Request{Op: "leave"}, &res, leaveTimeout)
	if errors.Is(err, daemon.ErrNotRunning) {
		if gone, why := nodeGone(st); gone {
			// An earlier leave finished in the daemon after its pen leave stopped waiting (or nothing
			// was ever founded here): what is left is the service.
			if mode != "none" {
				if err := removeService(mode, st); err != nil {
					return fail(stderr, fmt.Errorf("%s, but removing the %s service failed: %w", why, mode, err))
				}
				fmt.Fprintf(stdout, "%s; removed the %s service\n", why, mode)
				return 0
			}
			fmt.Fprintln(stdout, why)
			return 0
		}
	}
	var timeout net.Error
	if errors.As(err, &timeout) && timeout.Timeout() {
		// The daemon goes on with a leave it has begun; the service stays until it is known to be done.
		fmt.Fprintf(stderr, "pen: the leave is still in progress after %v; the %s service is kept. Run pen leave again: once the node has left it removes the service, until then it says the leave is running.\n", leaveTimeout, mode)
		return 1
	}
	if err != nil {
		if mode != "none" {
			fmt.Fprintf(stderr, "pen: leave failed, the %s service is kept: %v\n", mode, err)
			return 1
		}
		return fail(stderr, err)
	}
	fmt.Fprintln(stdout, "left the mesh and deleted this node's keys; told:")
	printResults(stdout, res.Results)
	// Only now that leave succeeded does the service go. The left marker stops a restart in the
	// meantime from minting a new node.
	if mode != "none" {
		if err := removeService(mode, st); err != nil {
			return fail(stderr, fmt.Errorf("left the mesh, but removing the %s service failed: %w", mode, err))
		}
	}
	return 0
}

// nodeGone reports whether no node is left in st: it left (the left marker) or none was ever made.
func nodeGone(st *state.Store) (bool, string) {
	if _, err := os.Stat(st.Path(daemon.LeftMarker)); err == nil {
		return true, "this node has already left its mesh"
	}
	if _, err := st.LoadIdentity(); errors.Is(err, os.ErrNotExist) {
		return true, "there is no node on this machine"
	}
	return false, ""
}
