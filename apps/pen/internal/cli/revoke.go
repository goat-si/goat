package cli

import (
	"fmt"
	"io"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
)

func printResults(w io.Writer, rs []daemon.PushResult) {
	if len(rs) == 0 {
		fmt.Fprintln(w, "no other members to tell")
	}
	for _, r := range rs {
		fmt.Fprintf(w, "  %s (%s): %s\n", r.Name, short(r.NodeID), r.Result)
	}
}

// RunRevoke removes a member and pushes the revoke to the others.
func RunRevoke(args []string, stdout, stderr io.Writer) int {
	fs := newFlags("revoke", stderr)
	compromised := fs.Bool("compromised", false, "also revoke every key this member admitted")
	pos, err := parse(fs, args)
	if err != nil {
		return 2
	}
	if len(pos) != 1 {
		fmt.Fprintln(stderr, "usage: pen revoke <member> [--compromised]")
		return 2
	}
	st, err := openState()
	if err != nil {
		return fail(stderr, err)
	}
	var ls daemon.LsReply
	if err := daemon.Call(st, daemon.Request{Op: "ls"}, &ls); err != nil {
		return fail(stderr, err)
	}
	m, err := Resolve(lsMembers(ls), pos[0])
	if err != nil {
		return fail(stderr, err)
	}
	var res struct{ Results []daemon.PushResult }
	if err := daemon.Call(st, daemon.Request{Op: "revoke", Subject: m.SignPub, Compromised: *compromised}, &res); err != nil {
		return fail(stderr, err)
	}
	fmt.Fprintf(stdout, "revoked %s (%s); pushed to:\n", m.Name, short(m.NodeID))
	printResults(stdout, res.Results)
	if *compromised && ls.Account != nil {
		fmt.Fprintf(stdout, "%s may still hold a Google sign-in for this mesh's account. Run pen lock on so new machines need approval, "+
			"change the Google password, and reset the account's machine list at %s/device after signing in.\n", m.Name, ls.Account.LoginURL)
	}
	return 0
}
