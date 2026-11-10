package cli

import (
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
)

// RunLock turns lock mode on or off: with it on, every machine that signs in waits for a member's
// pen approve.
func RunLock(args []string, stdout, stderr io.Writer) int {
	pos, err := parse(newFlags("lock", stderr), args)
	if err != nil {
		return 2
	}
	if len(pos) != 1 || pos[0] != "on" && pos[0] != "off" {
		fmt.Fprintln(stderr, "usage: pen lock on|off")
		return 2
	}
	st, err := openState()
	if err != nil {
		return fail(stderr, err)
	}
	var r struct {
		Results []daemon.PushResult `json:"results"`
		Locked  bool                `json:"locked"`
	}
	if err := daemon.Call(st, daemon.Request{Op: "lock", On: pos[0] == "on"}, &r); err != nil {
		return fail(stderr, err)
	}
	if r.Locked {
		fmt.Fprintln(stdout, "lock mode is on: machines that sign in wait for pen approve on a member")
	} else {
		fmt.Fprintln(stdout, "lock mode is off: machines that sign in with the mesh's Google account join at once")
	}
	printResults(stdout, r.Results)
	return 0
}

func pendingList(stderr io.Writer) ([]daemon.Pending, error) {
	st, err := openState()
	if err != nil {
		return nil, err
	}
	var r struct{ Pending []daemon.Pending }
	if err := daemon.Call(st, daemon.Request{Op: "pending"}, &r); err != nil {
		return nil, err
	}
	return r.Pending, nil
}

// RunApprove admits a queued request. A full fingerprint signs at once; a request id shows the
// request and asks first.
func RunApprove(args []string, stdout, stderr io.Writer) int {
	fs := newFlags("approve", stderr)
	pos, err := parse(fs, args)
	if err != nil {
		return 2
	}
	st, err := openState()
	if err != nil {
		return fail(stderr, err)
	}
	if len(pos) == 0 {
		ps, err := pendingList(stderr)
		if err != nil {
			return fail(stderr, err)
		}
		if len(ps) == 0 {
			fmt.Fprintln(stdout, "no pending requests")
			return 0
		}
		for _, p := range ps {
			printPending(stdout, p)
		}
		fmt.Fprintln(stdout, "approve one with: pen approve '<fingerprint>'")
		return 0
	}
	arg := strings.Join(pos, " ")
	switch len(normalize(arg)) {
	case 40:
	case 8:
		ps, err := pendingList(stderr)
		if err != nil {
			return fail(stderr, err)
		}
		var hits []daemon.Pending
		for _, p := range ps {
			if strings.HasPrefix(normalize(p.Fingerprint), normalize(arg)) {
				hits = append(hits, p)
			}
		}
		if len(hits) != 1 {
			return fail(stderr, fmt.Errorf("%d pending requests match %q; give the full fingerprint", len(hits), arg))
		}
		printPending(stdout, hits[0])
		if !confirm(stdout, false, "Approve this machine? It gets full access to every machine in the mesh.") {
			return fail(stderr, errors.New("not approved"))
		}
		arg = hits[0].Fingerprint
	default:
		return fail(stderr, fmt.Errorf("give the request id or the full fingerprint (8 or 40 hex characters), not %q", arg))
	}
	var r daemon.ApproveResult
	if err := daemon.Call(st, daemon.Request{Op: "approve", Subject: arg}, &r); err != nil {
		return fail(stderr, err)
	}
	fmt.Fprintf(stdout, "approved %s (%s, %s), fingerprint %s; told:\n", r.Member.Name, short(r.Member.NodeID), r.Member.Email, fingerprintOf(r.Member.NoisePub))
	printResults(stdout, r.Results)
	return 0
}

// RunDeny drops a queued request and refuses that machine for 24 hours.
func RunDeny(args []string, stdout, stderr io.Writer) int {
	pos, err := parse(newFlags("deny", stderr), args)
	if err != nil {
		return 2
	}
	if len(pos) == 0 {
		fmt.Fprintln(stderr, "usage: pen deny <id|fingerprint>")
		return 2
	}
	st, err := openState()
	if err != nil {
		return fail(stderr, err)
	}
	var r struct{ Denied daemon.Pending }
	if err := daemon.Call(st, daemon.Request{Op: "deny", Subject: strings.Join(pos, " ")}, &r); err != nil {
		return fail(stderr, err)
	}
	fmt.Fprintf(stdout, "denied %s (%s); it is refused for 24 hours\n", r.Denied.Name, r.Denied.Fingerprint)
	return 0
}

// RunAccount shows the mesh's account binding; "pen account unbind" removes it.
func RunAccount(args []string, stdout, stderr io.Writer) int {
	pos, err := parse(newFlags("account", stderr), args)
	if err != nil {
		return 2
	}
	st, err := openState()
	if err != nil {
		return fail(stderr, err)
	}
	switch {
	case len(pos) == 1 && pos[0] == "unbind":
		var r struct{ Results []daemon.PushResult }
		if err := daemon.Call(st, daemon.Request{Op: "account-unbind"}, &r); err != nil {
			return fail(stderr, err)
		}
		fmt.Fprintln(stdout, "the mesh is no longer bound to a Google account; machines join by invite only")
		printResults(stdout, r.Results)
		return 0
	case len(pos) == 0:
		var ls daemon.LsReply
		if err := daemon.Call(st, daemon.Request{Op: "ls"}, &ls); err != nil {
			return fail(stderr, err)
		}
		printAccount(stdout, ls)
		return 0
	}
	fmt.Fprintln(stderr, "usage: pen account [unbind]")
	return 2
}

func normalize(s string) string {
	return strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(s), " ", ""))
}

func printPending(w io.Writer, p daemon.Pending) {
	fmt.Fprintf(w, "request %s: %s (%s), signed in as %s at %s\n  fingerprint %s\n", p.ID, p.Name, short(p.NodeID), p.Email,
		time.UnixMilli(p.At).Format(time.DateTime), p.Fingerprint)
}
