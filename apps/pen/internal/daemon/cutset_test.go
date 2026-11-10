package daemon

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/login"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
)

// A revoked machine x that the login service still lists can admit a new machine j and serve it a cut
// copy of the mesh: x's own admit, x's revoke of the honest members and j's admit. FinishJoin dials every
// machine the service listed, so the honest member that refuses j (it holds x's compromised revoke)
// fails the join instead of j trusting x.
func TestFinishJoinFailsWhenAListedMachineTheServedViewCallsRevokedRefusesThisOne(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	x := joiner(t, ctx, rs, a.invite(t, time.Minute), "x")
	aPub := ident.B64.EncodeToString(a.d.id.SignPub)
	xPub := ident.B64.EncodeToString(x.d.id.SignPub)
	var res struct{ Results []PushResult }
	if err := Call(a.st, Request{Op: "revoke", Subject: xPub, Compromised: true}, &res); err != nil {
		t.Fatal(err)
	}
	// x never hears of its revoke; it revokes a in its own copy and invites j.
	if _, err := x.d.mesh().Append(x.d.id, mesh.TypeRevoke, time.Now().UnixMilli(), mesh.Fields{Subjects: []string{aPub}}); err != nil {
		t.Fatal(err)
	}
	x.d.viewChanged()
	tok := x.invite(t, time.Minute)
	jst := shortDir(t)
	jid := identity(t, jst, rs.URL, "j")
	s, err := Join(ctx, jst, jid, tok, "j")
	if err != nil {
		t.Fatalf("the cut join itself: %v", err)
	}
	listed := []login.OfferedMember{
		{NodeID: a.d.NodeID(), SignPub: aPub, NoisePub: ident.B64.EncodeToString(a.d.id.NoisePub), Name: "a"},
		{NodeID: x.d.NodeID(), SignPub: xPub, NoisePub: ident.B64.EncodeToString(x.d.id.NoisePub), Name: "x"},
	}
	_, _, err = FinishJoin(ctx, []string{rs.URL}, jid, s, listed)
	if err == nil || !strings.Contains(err.Error(), "a, listed for this account") {
		t.Fatalf("FinishJoin on x's cut copy: %v, want a refusal naming a", err)
	}
}
