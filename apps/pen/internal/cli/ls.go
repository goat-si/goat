package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
)

func fingerprintOf(noisePub string) string {
	k, err := ident.DecodeKey(noisePub)
	if err != nil {
		return "?"
	}
	return ident.Fingerprint(k)
}

func ago(ms int64) string {
	if ms == 0 {
		return "never"
	}
	d := time.Since(time.UnixMilli(ms)).Round(time.Second)
	if d < time.Second {
		return "just now"
	}
	return d.String() + " ago"
}

func printMembers(w io.Writer, ls daemon.LsReply) {
	printAccount(w, ls)
	tw := tabwriter.NewWriter(w, 2, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "NAME\tNODE\tFINGERPRINT\tPATH\tLAST SEEN\tVIA\tADMITTED BY\t24H IN/OUT")
	for _, m := range ls.Members {
		name, seen := m.Name, ago(m.LastSeen)
		if m.Self {
			name += " (this node)"
			seen = "uplink " + ls.Uplink
		} else if m.Online {
			seen = "online, " + seen
		} else if m.LastSeen == 0 {
			seen = "not seen yet"
		} else {
			seen = "offline, last seen " + seen
		}
		by := m.AdmittedByName
		if m.AdmittedBy == "" {
			by = "(founder)"
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\trelay\t%s\t%s\t%s\t%s\n", name, short(m.NodeID), m.Fingerprint, seen, via(m.Member), by, inOut(m.Traffic24h))
	}
	for _, m := range ls.Revoked {
		fmt.Fprintf(tw, "%s\t%s\t%s\t-\trevoked\t%s\t-\t%s\n", orDash(m.Name), short(m.NodeID), fingerprintOf(m.NoisePub), via(m.Member), inOut(m.Traffic24h))
	}
	tw.Flush()
	printTraffic(w, ls)
	printNotAMember(w, ls)
	var bare []string
	for _, m := range ls.Members {
		if !m.Self && len(m.HostKeys) == 0 {
			bare = append(bare, safe(m.Name))
		}
	}
	if len(bare) > 0 {
		fmt.Fprintf(w, "no ssh host keys from %s: ssh pen-<name> refuses them until they publish some (pen ls there says why, unless no SSH server runs there)\n", strings.Join(bare, ", "))
	}
	for _, m := range ls.Members {
		if m.Via == mesh.ViaGoogle && time.Since(time.UnixMilli(m.Since)) < announceFor {
			fmt.Fprintf(w, "%s joined via Google %s, fingerprint %s (%s)\n", m.Name, safe(m.Email), m.Fingerprint, ago(m.Since))
		}
	}
}

// inOut is a member's 24-hour stream bytes for the table.
func inOut(t *daemon.MemberTraffic) string {
	if t == nil {
		return "-"
	}
	return humanBytes(t.In) + " / " + humanBytes(t.Out)
}

// printTraffic adds each relay's 24-hour total, and when the daemon has counted for less than 24 hours, since when.
func printTraffic(w io.Writer, ls daemon.LsReply) {
	for _, r := range ls.Relays24h {
		url := r.URL
		if url == "" {
			url = "other relays"
		}
		fmt.Fprintf(w, "relay    %s: %s in, %s out in 24 h\n", safe(url), humanBytes(r.In), humanBytes(r.Out))
	}
	if ls.TrafficSince != 0 && time.Since(time.UnixMilli(ls.TrafficSince)) < 23*time.Hour {
		fmt.Fprintf(w, "traffic  counted since %s, when the daemon started; pen pipe, pen forward and sessions this machine accepted\n",
			time.UnixMilli(ls.TrafficSince).Format("2006-01-02 15:04"))
	}
}

// humanBytes writes n in SI units (1 kB is 1000 bytes) with three significant digits.
func humanBytes(n uint64) string {
	if n < 1000 {
		return fmt.Sprintf("%d B", n)
	}
	f := float64(n)
	for _, unit := range []string{"kB", "MB", "GB", "TB", "PB"} {
		f /= 1000
		if f < 999.5 || unit == "PB" {
			switch {
			case f < 9.995:
				return fmt.Sprintf("%.2f %s", f, unit)
			case f < 99.95:
				return fmt.Sprintf("%.1f %s", f, unit)
			}
			return fmt.Sprintf("%.0f %s", f, unit)
		}
	}
	return ""
}

// announceFor is how long pen ls announces a member admitted for a Google account.
const announceFor = 7 * 24 * time.Hour

// printNotAMember says when this machine's own key is not a member of the mesh it holds: it can
// still reach members it knows, but admits nobody and no member serves it.
func printNotAMember(w io.Writer, ls daemon.LsReply) {
	for _, m := range ls.Members {
		if m.Self || m.NodeID == ls.Self {
			return
		}
	}
	why := "the admit that added it never took effect (the machine that admitted it was revoked first)"
	for _, m := range ls.Revoked {
		if m.NodeID == ls.Self {
			why = "it was revoked"
		}
	}
	dir := ls.StateDir
	if dir == "" {
		dir = "the state folder (~/.pen, or PEN_HOME)"
	}
	// pen leave would need a member to take its revoke; this needs none.
	fmt.Fprintf(w, "this machine is not a member of mesh %s: %s. To use it again: pen down, remove %s, then join with an invite or pen login through a current member.\n", ls.MeshID, why, dir)
}

func via(m mesh.Member) string {
	switch {
	case m.Via == mesh.ViaGoogle:
		return "google " + safe(m.Email)
	case m.AdmittedBy == "":
		return "-"
	}
	return "invite"
}

// printAccount prints the mesh's account binding, lock mode and pending requests.
func printAccount(w io.Writer, ls daemon.LsReply) {
	if ls.Account == nil {
		fmt.Fprintln(w, "account  none (machines join by invite)")
	} else {
		fmt.Fprintf(w, "account  Google sub %s via %s, login key %s\n", safe(ls.Account.Sub), safe(ls.Account.LoginURL), ls.Account.LoginKey.Kid)
	}
	if ls.Locked {
		fmt.Fprintf(w, "lock     on: new machines wait for pen approve (%d pending here)\n", ls.Pending)
	}
	if ls.SaveError != "" {
		fmt.Fprintf(w, "state    cannot be written (%s): records other members send are not kept and their syncs fail; free disk space or fix the folder's permissions\n", safe(ls.SaveError))
	}
	if ls.HostKeysError != "" {
		fmt.Fprintf(w, "ssh      %s\n", safe(ls.HostKeysError))
	}
	if ls.Records >= mesh.MaxOrdinary {
		fmt.Fprintf(w, "mesh     full: %d records (new members, names, locks and bindings stop at %d, revokes at %d); move to a new mesh\n", ls.Records, mesh.MaxOrdinary, mesh.MaxRecords)
	}
	for _, u := range ls.Unforgotten {
		fmt.Fprintf(w, "login    still offers removed %s (%s) to new machines; this machine is not registered with the account, so run pen login here or reset the machine list at %s/reset\n",
			orDash(u.Name), short(u.NodeID), u.LoginURL)
	}
}

// safe replaces control characters, so a record's text cannot redraw the terminal.
func safe(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return '?'
		}
		return r
	}, s)
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// RunLs lists the mesh, or streams its changes with --watch.
func RunLs(args []string, stdout, stderr io.Writer) int {
	fs := newFlags("ls", stderr)
	asJSON := fs.Bool("json", false, "print JSON")
	watch := fs.Bool("watch", false, "print a line on every view change")
	until := fs.String("until-revoked", "", "with --watch: exit 0 once this member is revoked")
	if _, err := parse(fs, args); err != nil {
		return 2
	}
	st, err := openState()
	if err != nil {
		return fail(stderr, err)
	}
	var ls daemon.LsReply
	err = daemon.Call(st, daemon.Request{Op: "ls"}, &ls)
	if errors.Is(err, daemon.ErrNotRunning) && !*watch {
		v, verr := localView(st)
		if verr != nil {
			return fail(stderr, verr)
		}
		id, _ := st.LoadIdentity()
		ls = offlineLs(v, id)
	} else if err != nil {
		return fail(stderr, err)
	}
	ls.StateDir = st.Dir
	if !*watch {
		if *asJSON {
			b, _ := json.MarshalIndent(ls, "", "  ")
			fmt.Fprintln(stdout, string(b))
		} else {
			printMembers(stdout, ls)
		}
		return 0
	}
	target := ""
	if *until != "" {
		all := append(lsMembers(ls), revokedMembers(ls)...)
		m, err := Resolve(all, *until)
		if err != nil {
			return fail(stderr, err)
		}
		target = m.NodeID
	}
	cl, err := daemon.Dial(st)
	if err != nil {
		return fail(stderr, err)
	}
	defer cl.Close()
	if err := cl.Send(daemon.Request{Op: "watch"}); err != nil {
		return fail(stderr, err)
	}
	for {
		var w daemon.WatchLine
		if err := cl.Next(&w); err != nil {
			return fail(stderr, errors.New("the daemon closed the watch"))
		}
		if *asJSON {
			b, _ := json.Marshal(w)
			fmt.Fprintln(stdout, string(b))
		} else {
			fmt.Fprintf(stdout, "%s members: %s; revoked: %s\n", time.UnixMilli(w.At).Format(time.TimeOnly), refNames(w.Members), refNames(w.Revoked))
		}
		if target != "" {
			for _, r := range w.Revoked {
				if r.NodeID == target {
					return 0
				}
			}
		}
	}
}

func refNames(rs []daemon.NameRef) string {
	if len(rs) == 0 {
		return "-"
	}
	var out []string
	for _, r := range rs {
		out = append(out, orDash(r.Name)+"("+short(r.NodeID)+")")
	}
	return strings.Join(out, ", ")
}

func revokedMembers(ls daemon.LsReply) []mesh.Member {
	out := make([]mesh.Member, 0, len(ls.Revoked))
	for _, m := range ls.Revoked {
		out = append(out, m.Member)
	}
	return out
}

func lsMembers(ls daemon.LsReply) []mesh.Member {
	out := make([]mesh.Member, 0, len(ls.Members))
	for _, m := range ls.Members {
		out = append(out, m.Member)
	}
	return out
}

func offlineLs(v *mesh.View, id *ident.Identity) daemon.LsReply {
	ls := daemon.LsReply{MeshID: v.MeshID, Uplink: "daemon not running", Revoked: []daemon.LsRevoked{}, Account: v.Account, Locked: v.Locked}
	for _, m := range v.SortedRevoked() {
		ls.Revoked = append(ls.Revoked, daemon.LsRevoked{Member: m})
	}
	if id != nil {
		ls.Self = id.NodeID()
	}
	for _, m := range v.SortedMembers() {
		lm := daemon.LsMember{Member: m, Fingerprint: fingerprintOf(m.NoisePub), Self: m.NodeID == ls.Self}
		if a, ok := v.Members[m.AdmittedBy]; ok {
			lm.AdmittedByName = a.Name
		}
		ls.Members = append(ls.Members, lm)
	}
	return ls
}
