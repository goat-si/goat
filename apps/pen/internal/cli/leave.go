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
	var res struct{ Results []daemon.PushResult }
	if err := daemon.Call(st, daemon.Request{Op: "leave"}, &res); err != nil {
		return fail(stderr, err)
	}
	fmt.Fprintln(stdout, "left the mesh and deleted this node's keys; told:")
	printResults(stdout, res.Results)
	if mode != "none" {
		if err := removeService(mode); err != nil {
			return fail(stderr, err)
		}
	}
	return 0
}

