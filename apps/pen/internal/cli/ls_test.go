package cli

import (
	"bytes"
	"strings"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
)

// A machine whose own key is not a member (revoked, or its admit lost to a revoke of the machine
// that admitted it) still runs; pen ls must say so and what to do, not just list the others.
func TestLsSaysWhenThisMachineIsNotAMember(t *testing.T) {
	other := daemon.LsMember{Member: mesh.Member{Name: "a", NodeID: "aaaaaaaaaaaaaaaaaaaaaaaaaa"}}
	for _, c := range []struct {
		ls   daemon.LsReply
		want string
	}{
		{daemon.LsReply{Self: "selfnodeidaaaaaaaaaaaaaaaa", MeshID: "m", Members: []daemon.LsMember{other}}, "never took effect"},
		{daemon.LsReply{Self: "selfnodeidaaaaaaaaaaaaaaaa", MeshID: "m", Members: []daemon.LsMember{other},
			Revoked: []daemon.LsRevoked{{Member: mesh.Member{Name: "y", NodeID: "selfnodeidaaaaaaaaaaaaaaaa"}}}}, "was revoked"},
	} {
		var w bytes.Buffer
		printMembers(&w, c.ls)
		c.ls.StateDir = "/home/u/.pen"
		w.Reset()
		printMembers(&w, c.ls)
		advice := "To use it again: pen down, remove /home/u/.pen, then join with an invite or pen login through a current member."
		if !strings.Contains(w.String(), "this machine is not a member of mesh m") || !strings.Contains(w.String(), c.want) || !strings.Contains(w.String(), advice) {
			t.Fatalf("pen ls on a machine that is not a member printed:\n%s\nwant a line saying it %s", w.String(), c.want)
		}
	}
	var w bytes.Buffer
	self := other
	self.Self = true
	printMembers(&w, daemon.LsReply{Self: self.NodeID, MeshID: "m", Members: []daemon.LsMember{self}})
	if strings.Contains(w.String(), "not a member") {
		t.Fatalf("pen ls on a member says it is not one:\n%s", w.String())
	}
}

// P1: ssh pen-<name> to a member that published no host keys fails strict checking with no hint, so
// pen ls names such members everywhere, and on the member itself says which key files it cannot read.
func TestLsNamesMembersWithoutHostKeysAndTheKeyFilesThisMachineCannotRead(t *testing.T) {
	self := daemon.LsMember{Member: mesh.Member{Name: "mac", NodeID: "selfnodeidaaaaaaaaaaaaaaaa"}, Self: true}
	win := daemon.LsMember{Member: mesh.Member{Name: "win", NodeID: "winnodeidaaaaaaaaaaaaaaaaa"}}
	linux := daemon.LsMember{Member: mesh.Member{Name: "linux", NodeID: "lnxnodeidaaaaaaaaaaaaaaaaa", HostKeys: []string{"ssh-ed25519 AAAA"}}}
	var w bytes.Buffer
	printMembers(&w, daemon.LsReply{Self: self.NodeID, Members: []daemon.LsMember{self, win, linux}})
	if !strings.Contains(w.String(), "no ssh host keys from win:") || strings.Contains(w.String(), "from win, linux") {
		t.Fatalf("pen ls with a member that published no host keys printed:\n%s", w.String())
	}
	w.Reset()
	win.Self, self.Self = true, false
	printMembers(&w, daemon.LsReply{Self: win.NodeID, Members: []daemon.LsMember{self, win}, HostKeysError: `cannot read C:\ProgramData\ssh\ssh_host_ed25519_key.pub (Access is denied.)`})
	if !strings.Contains(w.String(), `ssh      cannot read C:\ProgramData\ssh\ssh_host_ed25519_key.pub`) {
		t.Fatalf("pen ls on a member that cannot read its host keys printed:\n%s", w.String())
	}
}
