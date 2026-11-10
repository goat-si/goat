package cli

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
)

// openFile opens a local file in the desktop's browser (a seam for tests).
var openFile = func(path string) error {
	switch {
	case runtime.GOOS == "darwin":
		return exec.Command("open", path).Run()
	case os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != "":
		return exec.Command("xdg-open", path).Run()
	}
	return errNoDesktop
}

var errNoDesktop = fmt.Errorf("no desktop to open a browser on")

// RunDashboard asks the running daemon for its local management page and opens it. The one-time
// token never goes on a command line: the browser opens a redirect file the daemon wrote (0600),
// which the daemon deletes once the token is used, expires or the dashboard stops.
func RunDashboard(args []string, stdout, stderr io.Writer) int {
	fs := newFlags("dashboard", stderr)
	noOpen := fs.Bool("no-open", false, "print the address without opening a browser")
	stop := fs.Bool("stop", false, "close the dashboard and end every session")
	pos, err := parse(fs, args)
	if err != nil {
		return 2
	}
	if len(pos) != 0 {
		fmt.Fprintln(stderr, "usage: pen dashboard [--no-open] [--stop]")
		return 2
	}
	st, err := openState()
	if err != nil {
		return fail(stderr, err)
	}
	if *stop {
		var r struct{ Stopped bool }
		if err := daemon.Call(st, daemon.Request{Op: "dashboard-stop"}, &r); err != nil {
			return fail(stderr, err)
		}
		if r.Stopped {
			fmt.Fprintln(stdout, "the dashboard is closed and every session ended")
		} else {
			fmt.Fprintln(stdout, "no dashboard was running")
		}
		return 0
	}
	var r daemon.DashboardReply
	if err := daemon.Call(st, daemon.Request{Op: "dashboard"}, &r); err != nil {
		return fail(stderr, err)
	}
	printLink := func() {
		fmt.Fprintf(stdout, "pen dashboard (this link works once, for 10 minutes, on this machine only):\n  %s\n", r.URL)
	}
	if *noOpen {
		printLink()
		return 0
	}
	// The link holds the one-time token; printed only when no browser took it, so it stays out of
	// the terminal's scrollback otherwise.
	if err := openFile(r.File); err != nil {
		printLink()
		fmt.Fprintf(stdout, "open the link above in a browser on this machine (%v)\n", err)
		return 0
	}
	fmt.Fprintln(stdout, "opened the dashboard in your browser; pen dashboard --stop closes it and ends every session")
	return 0
}
