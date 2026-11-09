package cli

import (
	"fmt"
	"io"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
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
	mode := installedService(st)
	// Take the service out of the service manager first, so nothing restarts the daemon once
	// leave stops it (the units also restart only on failure, and the left marker backs this up).
	if mode != "none" {
		if err := detachService(mode); err != nil {
			return fail(stderr, err)
		}
	}
	var res struct{ Results []daemon.PushResult }
	if err := daemon.Call(st, daemon.Request{Op: "leave"}, &res); err != nil {
		return fail(stderr, err)
	}
	fmt.Fprintln(stdout, "left the mesh and deleted this node's keys; told:")
	printResults(stdout, res.Results)
	if mode == "launchd" {
		unloadLaunchd()
	}
	return 0
}
