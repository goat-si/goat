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
	fmt.Fprintln(tw, "NAME\tNODE\tFINGERPRINT\tPATH\tLAST SEEN\tVIA\tADMITTED BY")
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
		fmt.Fprintf(tw, "%s\t%s\t%s\trelay\t%s\t%s\t%s\n", name, short(m.NodeID), m.Fingerprint, seen, via(m.Member), by)
	}
	for _, m := range ls.Revoked {
		fmt.Fprintf(tw, "%s\t%s\t%s\t-\trevoked\t%s\t-\n", orDash(m.Name), short(m.NodeID), fingerprintOf(m.NoisePub), via(m))
	}
	tw.Flush()
	for _, m := range ls.Members {
		if m.Via == mesh.ViaGoogle && time.Since(time.UnixMilli(m.Since)) < announceFor {
			fmt.Fprintf(w, "%s joined via Google %s, fingerprint %s (%s)\n", m.Name, safe(m.Email), m.Fingerprint, ago(m.Since))
		}
	}
}

// announceFor is how long pen ls announces a member admitted for a Google account.
const announceFor = 7 * 24 * time.Hour

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
		all := append(lsMembers(ls), ls.Revoked...)
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

func lsMembers(ls daemon.LsReply) []mesh.Member {
	out := make([]mesh.Member, 0, len(ls.Members))
	for _, m := range ls.Members {
		out = append(out, m.Member)
	}
	return out
}

func offlineLs(v *mesh.View, id *ident.Identity) daemon.LsReply {
	ls := daemon.LsReply{MeshID: v.MeshID, Uplink: "daemon not running", Revoked: v.SortedRevoked(), Account: v.Account, Locked: v.Locked}
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
