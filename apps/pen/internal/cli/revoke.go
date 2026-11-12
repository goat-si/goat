package cli

import (
	"fmt"
	"io"
	"strings"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
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
	var m mesh.Member
	if *compromised {
		m, err = resolveCompromised(ls, pos[0])
	} else {
		m, err = Resolve(lsMembers(ls), pos[0])
	}
	if err != nil {
		return fail(stderr, err)
	}
	if *compromised {
		fmt.Fprintf(stdout, "revoking as compromised: %s\n", describe(m, stateOf(ls, m)))
	}
	var res struct{ Results []daemon.PushResult }
	if err := daemon.Call(st, daemon.Request{Op: "revoke", Subject: m.SignPub, Compromised: *compromised}, &res); err != nil {
		return fail(stderr, err)
	}
	fmt.Fprintf(stdout, "revoked %s (%s); pushed to:\n", m.Name, short(m.NodeID))
	printResults(stdout, res.Results)
	if next := daemon.CompromisedNextSteps(m.Name, ls.Account); *compromised && next != "" {
		fmt.Fprintln(stdout, next)
	}
	return 0
}

// resolveCompromised finds the machine to revoke as compromised among current members and the
// machines that left or were revoked: a stolen machine may be found after it left. A name both a
// departed and a current machine carry is refused, since a replacement may join under the old
// name; the node id or fingerprint (or a start of either) then picks one.
func resolveCompromised(ls daemon.LsReply, arg string) (mesh.Member, error) {
	all := append(lsMembers(ls), revokedMembers(ls)...)
	q := strings.ToLower(strings.TrimPrefix(arg, "pen-"))
	full := strings.ToLower(arg)
	fp := normalFingerprint(arg)
	hexStart := len(fp) >= 8 && isHex(fp)
	// Every way arg can name a machine counts: a name can be another machine's node id or
	// fingerprint start, and a wrong pick revokes a healthy machine and what it admitted.
	var found []mesh.Member
	for _, m := range all {
		if m.Name == q || m.Name == full || len(q) >= 4 && strings.HasPrefix(m.NodeID, q) ||
			hexStart && strings.HasPrefix(normalFingerprint(fingerprintOf(m.NoisePub)), fp) {
			found = append(found, m)
		}
	}
	switch len(found) {
	case 1:
		return found[0], nil
	case 0:
		return mesh.Member{}, fmt.Errorf("no machine is named %q or has a node id (4 characters or more) or fingerprint (8 digits or more) starting with it", arg)
	}
	return mesh.Member{}, fmt.Errorf("%d machines match %q by name, node id or fingerprint:\n%s", len(found), arg, choices(ls, found))
}

// choices lists the machines an argument matched, each with the command that names it alone.
func choices(ls daemon.LsReply, ms []mesh.Member) string {
	lines := []string{}
	for _, m := range ms {
		lines = append(lines, "  "+describe(m, stateOf(ls, m)))
	}
	// A whole fingerprint is longer than any name or node id, so it names one machine.
	lines = append(lines, "name the stolen one by its fingerprint:")
	for _, m := range ms {
		lines = append(lines, "  pen revoke --compromised "+normalFingerprint(fingerprintOf(m.NoisePub)))
	}
	return strings.Join(lines, "\n")
}

func isHex(s string) bool {
	return strings.Trim(s, "0123456789ABCDEF") == ""
}

// stateOf says whether m is a current member or one that left or was revoked.
func stateOf(ls daemon.LsReply, m mesh.Member) string {
	for _, x := range ls.Members {
		if x.SignPub == m.SignPub {
			return "current member"
		}
	}
	return "left or revoked"
}

func describe(m mesh.Member, state string) string {
	return fmt.Sprintf("%s, node id %s, fingerprint %s, %s", m.Name, m.NodeID, fingerprintOf(m.NoisePub), state)
}

// normalFingerprint drops spaces and case so a fingerprint can be pasted as pen ls prints it.
func normalFingerprint(s string) string {
	return strings.ToUpper(strings.Join(strings.Fields(s), ""))
}
