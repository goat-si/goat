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
		release, err := taskTurn(st, "pen leave", stderr)
		if err != nil {
			return fail(stderr, err)
		}
		defer release()
	}
	mode := installedService(st)
	var res struct{ Results []daemon.PushResult }
	err = daemon.CallWithin(st, daemon.Request{Op: "leave"}, &res, leaveTimeout)
	if errors.Is(err, daemon.ErrNotRunning) {
		if why, ok := leftOrEmpty(st); ok {
			// A leave that finished in the daemon after its pen leave stopped waiting, or one that could
			// not delete every file: delete what is left first, and only then the service. With no
			// identity and no left marker nothing of a node is here: only the task or unit goes.
			// A daemon that holds daemon.lock but does not answer still runs here; it does its own leave.
			if release, err := state.TryLock(st.Path("daemon.lock")); errors.Is(err, state.ErrLocked) {
				fmt.Fprintf(stderr, "pen: a pen daemon still runs here (it holds %s) but does not answer; the %s service is kept. Run pen down, then pen leave again.\n", st.Path("daemon.lock"), mode)
				return 1
			} else if err == nil {
				release()
			}
			if _, err := os.Stat(st.Path(daemon.LeftMarker)); err == nil {
				if leaveResumes != nil {
					leaveResumes()
				}
				switch err := daemon.FinishLeave(st); {
				case errors.Is(err, daemon.ErrNotLeaving):
					fmt.Fprintf(stderr, "pen: this node is not leaving its mesh, so there is nothing to finish (pen up, pen join or pen login started a node here meanwhile); the %s service is kept\n", mode)
					return 1
				case err != nil:
					fmt.Fprintf(stderr, "pen: %v; the %s service is kept\n", err, mode)
					return 1
				}
			}
			if mode != "none" {
				if err := removeService(mode, st); err != nil {
					return fail(stderr, fmt.Errorf("%s, but removing the %s service failed: %w", why, mode, err))
				}
				fmt.Fprintf(stdout, "%s; removed the background service (%s)\n", why, mode)
				return 0
			}
			fmt.Fprintf(stdout, "%s; nothing else to remove\n", why)
			return 0
		}
	}
	if errors.Is(err, daemon.ErrNotSent) {
		fmt.Fprintf(stderr, "pen: the daemon did not take the leave request (%v); nothing changed and the %s service is kept. Run pen leave again.\n", err, mode)
		return 1
	}
	var timeout net.Error
	if errors.As(err, &timeout) && timeout.Timeout() {
		// The daemon goes on with a leave it has begun; the service stays until it is known to be done.
		fmt.Fprintf(stderr, "pen: the leave is still in progress after %v; the %s service is kept. Run pen leave again: once the node has left it removes the service, until then it says the leave is running.\n", leaveTimeout, mode)
		return 1
	}
	if err != nil {
		if mode != "none" {
			fmt.Fprintf(stderr, "pen: leave did not finish, the %s service is kept: %v\n", mode, err)
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

// leaveResumes runs when a resumed pen leave is about to finish the deletion (a seam for tests).
var leaveResumes func()

// leftOrEmpty reports why no running node is left in st: it left (the left marker, though files may
// remain for FinishLeave), or no Pen identity is in the folder at all (never made, or the folder is not
// what it was, such as storage that is not mounted).
func leftOrEmpty(st *state.Store) (string, bool) {
	if _, err := os.Stat(st.Path(daemon.LeftMarker)); err == nil {
		return "this node has already left its mesh", true
	}
	if _, err := st.LoadIdentity(); errors.Is(err, os.ErrNotExist) {
		return "no Pen identity in " + st.Dir, true
	}
	return "", false
}
