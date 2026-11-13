package cli

import (
	"fmt"
	"io"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
)

// RunInvite creates a single-use invite and prints its token and install one-liner.
func RunInvite(args []string, stdout, stderr io.Writer) int {
	fs := newFlags("invite", stderr)
	ttl := fs.Duration("ttl", 10*time.Minute, "how long the invite stays valid")
	auto := fs.Bool("auto", false, "print the token and exit instead of waiting for the join")
	if _, err := parse(fs, args); err != nil {
		return 2
	}
	st, err := openState()
	if err != nil {
		return fail(stderr, err)
	}
	cl, err := daemon.Dial(st)
	if err != nil {
		return fail(stderr, err)
	}
	defer cl.Close()
	if err := cl.Send(daemon.Request{Op: "invite", TTLMs: ttl.Milliseconds(), Wait: !*auto}); err != nil {
		return fail(stderr, err)
	}
	var r struct {
		Token     string `json:"token"`
		Relay     string `json:"relay"`
		ExpiresAt int64  `json:"expiresAt"`
		Command   string `json:"command"`
		// WindowsCommand is the same install for PowerShell.
		WindowsCommand string `json:"windowsCommand"`
	}
	if err := cl.Next(&r); err != nil {
		return fail(stderr, err)
	}
	if *auto {
		fmt.Fprintln(stdout, r.Token)
		return 0
	}
	fmt.Fprintf(stdout, "invite (single use, expires %s):\n  %s\n\non the new machine:\n  %s\n\non a new Windows machine, in PowerShell:\n  %s\n\nwaiting for the join (Ctrl-C leaves the invite valid)...\n",
		time.UnixMilli(r.ExpiresAt).Format(time.Kitchen), r.Token, r.Command, r.WindowsCommand)
	var ev struct {
		T      string      `json:"t"`
		Member mesh.Member `json:"member"`
		// Delivered is false when the joiner was admitted but its join did not finish.
		Delivered *bool `json:"delivered"`
	}
	if err := cl.Next(&ev); err != nil {
		return fail(stderr, err)
	}
	if ev.T == "expired" {
		fmt.Fprintln(stderr, "pen: the invite expired unused")
		return 1
	}
	if ev.T == "cancelled" {
		fmt.Fprintln(stderr, "pen: the invite was cancelled")
		return 1
	}
	if ev.T == "burned" {
		fmt.Fprintln(stderr, "pen: the invite was used, but no admission was reported (pen ls shows whether the machine joined)")
		return 1
	}
	if ev.T != "admitted" {
		fmt.Fprintf(stderr, "pen: the invite ended with %q, not a join\n", ev.T)
		return 1
	}
	noise := ev.Member.NoisePub
	if ev.Delivered != nil && !*ev.Delivered {
		fmt.Fprintf(stderr, "pen: admitted %s (%s), fingerprint %s, but its join did not finish on that machine, which is now a member without a copy of the mesh\n",
			ev.Member.Name, short(ev.Member.NodeID), fingerprintOf(noise))
		return 1
	}
	fmt.Fprintf(stdout, "admitted %s (%s), fingerprint %s\n", ev.Member.Name, short(ev.Member.NodeID), fingerprintOf(noise))
	return 0
}
