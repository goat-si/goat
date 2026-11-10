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
			Revoked: []mesh.Member{{Name: "y", NodeID: "selfnodeidaaaaaaaaaaaaaaaa"}}}, "was revoked"},
	} {
		var w bytes.Buffer
		printMembers(&w, c.ls)
		if !strings.Contains(w.String(), "this machine is not a member of mesh m") || !strings.Contains(w.String(), c.want) {
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
