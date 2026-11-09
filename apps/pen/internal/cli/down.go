package cli

import (
	"fmt"
	"io"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
)

// RunDown stops the daemon (and its service, if one is installed).
func RunDown(args []string, stdout, stderr io.Writer) int {
	if _, err := parse(newFlags("down", stderr), args); err != nil {
		return 2
	}
	st, err := openState()
	if err != nil {
		return fail(stderr, err)
	}
	if mode := installedService(st); mode != "none" {
		if err := stopService(mode); err != nil {
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
	var ok map[string]bool
	if err := cl.Send(daemon.Request{Op: "stop"}); err != nil {
		return fail(stderr, err)
	}
	if err := cl.Next(&ok); err != nil {
		return fail(stderr, err)
	}
	fmt.Fprintln(stdout, "stopped pen")
	return 0
}
