package daemon

import (
	"context"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/login"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
)

func listedAs(n *node, name string) login.OfferedMember {
	return login.OfferedMember{NodeID: n.d.NodeID(), SignPub: ident.B64.EncodeToString(n.id.SignPub),
		NoisePub: ident.B64.EncodeToString(n.id.NoisePub), Name: name}
}

func stop(t *testing.T, n *node) {
	t.Helper()
	n.d.Stop()
	if err := <-n.done; err != nil {
		t.Fatal(err)
	}
	n.done <- nil
}

// A machine revoked plainly keeps running and stays listed until its forget reaches the login
// service. It refuses a new joiner it never heard of, but that refusal says nothing against the
// member that admitted the joiner: the join goes on.
func TestARunningPlainlyRevokedListedMachineDoesNotFailAGoogleJoin(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := loginFake(t)
	a := founder(t, ctx, rs, "a", nil)
	y := joiner(t, ctx, rs, a.invite(t, time.Minute), "y")
	bindTo(t, a, f, f.Key())
	var r map[string]any
	if err := Call(a.st, Request{Op: "revoke", Subject: ident.B64.EncodeToString(y.id.SignPub)}, &r); err != nil {
		t.Fatal(err)
	}
	j := newcomer(t)
	as := f.Issue(testSub, "me@example.com", j.SignPub, j.NoisePub, time.Now())
	out, _, err := AccountJoin(ctx, []string{rs.URL}, j, "j", as, offeredBy(t, a))
	if err != nil {
		t.Fatal(err)
	}
	s, err := mesh.CheckJoined(nil, j, out.MeshID, out.Records)
	if err != nil {
		t.Fatal(err)
	}
	listed := []login.OfferedMember{listedAs(a, "a"), listedAs(y, "y")}
	if _, _, err := FinishJoin(ctx, []string{rs.URL}, j, s, listed, as); err != nil {
		t.Fatalf("the join failed on a plainly revoked machine's refusal: %v", err)
	}
}

// y was admitted through z, and z went offline before anyone else heard of y. The member that
// admits the joiner does not know y, and y does not know the joiner. Once y's records are in, the
// joiner is still a member: the join goes on and the joiner knows y.
func TestAListedMemberNobodyHeardOfYetDoesNotFailAGoogleJoin(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := loginFake(t)
	a := founder(t, ctx, rs, "a", nil)
	bindTo(t, a, f, f.Key())
	z := joiner(t, ctx, rs, a.invite(t, time.Minute), "z")
	stop(t, a)
	y := joiner(t, ctx, rs, z.invite(t, time.Minute), "y")
	stop(t, z)
	a = start(t, ctx, rs, a.st, nil)
	if _, known := a.d.view().Members[ident.B64.EncodeToString(y.id.SignPub)]; known {
		t.Fatal("a heard of y; the test needs it not to")
	}
	j := newcomer(t)
	as := f.Issue(testSub, "me@example.com", j.SignPub, j.NoisePub, time.Now())
	out, _, err := AccountJoin(ctx, []string{rs.URL}, j, "j", as, offeredBy(t, a))
	if err != nil {
		t.Fatal(err)
	}
	s, err := mesh.CheckJoined(nil, j, out.MeshID, out.Records)
	if err != nil {
		t.Fatal(err)
	}
	listed := []login.OfferedMember{listedAs(a, "a"), listedAs(y, "y")}
	if _, _, err := FinishJoin(ctx, []string{rs.URL}, j, s, listed, as); err != nil {
		t.Fatalf("the join failed on a member nobody had heard of yet: %v", err)
	}
	if _, ok := s.View().Members[ident.B64.EncodeToString(y.id.SignPub)]; !ok {
		t.Fatal("the joiner does not know y after the join")
	}
}

// b was admitted by x, and x was later revoked plainly, so b is still a member. y, revoked plainly
// itself and still running, knows both and refuses j, whom b admitted, on kind 0x01; the check
// must still take j, since y trusts b.
func TestAListedNodeTakesAJoinerWhoseAdmitterWasItselfAdmittedByAPlainlyRevokedKey(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := loginFake(t)
	a := founder(t, ctx, rs, "a", nil)
	bindTo(t, a, f, f.Key())
	x := joiner(t, ctx, rs, a.invite(t, time.Minute), "x")
	b := joiner(t, ctx, rs, x.invite(t, time.Minute), "b")
	y := joiner(t, ctx, rs, a.invite(t, time.Minute), "y")
	var r map[string]any
	for _, gone := range []*node{x, y} {
		if err := Call(a.st, Request{Op: "revoke", Subject: ident.B64.EncodeToString(gone.id.SignPub)}, &r); err != nil {
			t.Fatal(err)
		}
	}
	j := newcomer(t)
	as := f.Issue(testSub, "me@example.com", j.SignPub, j.NoisePub, time.Now())
	out, _, err := AccountJoin(ctx, []string{rs.URL}, j, "j", as, offeredBy(t, b))
	if err != nil {
		t.Fatal(err)
	}
	s, err := mesh.CheckJoined(nil, j, out.MeshID, out.Records)
	if err != nil {
		t.Fatal(err)
	}
	listed := []login.OfferedMember{listedAs(a, "a"), listedAs(b, "b"), listedAs(y, "y")}
	if _, _, err := FinishJoin(ctx, []string{rs.URL}, j, s, listed, as); err != nil {
		t.Fatalf("the join failed although y trusts the member that admitted j: %v", err)
	}
}

// The listed check counts only a refusal: a listed node that does not answer (here offline, 4404)
// takes no part, and the join goes on. The protection against a cut copy holds only while an honest
// listed node answers.
func TestAListedNodeThatDoesNotAnswerTakesNoPartInTheJoin(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := loginFake(t)
	a := founder(t, ctx, rs, "a", nil)
	bindTo(t, a, f, f.Key())
	y := joiner(t, ctx, rs, a.invite(t, time.Minute), "y")
	var r map[string]any
	if err := Call(a.st, Request{Op: "revoke", Subject: ident.B64.EncodeToString(y.id.SignPub)}, &r); err != nil {
		t.Fatal(err)
	}
	stop(t, y)
	j := newcomer(t)
	as := f.Issue(testSub, "me@example.com", j.SignPub, j.NoisePub, time.Now())
	out, _, err := AccountJoin(ctx, []string{rs.URL}, j, "j", as, offeredBy(t, a))
	if err != nil {
		t.Fatal(err)
	}
	s, err := mesh.CheckJoined(nil, j, out.MeshID, out.Records)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := FinishJoin(ctx, []string{rs.URL}, j, s, []login.OfferedMember{listedAs(a, "a"), listedAs(y, "y")}, as); err != nil {
		t.Fatalf("an offline listed node failed the join: %v", err)
	}
}

// A machine that is not a member of its mesh (revoked, or its admit lost to a revoke of its
// admitter) still runs and the registry may still offer it, but it can admit nobody: it refuses a
// Google join at once, before signing an admit that would count nowhere.
func TestAMachineThatIsNotAMemberRefusesAGoogleJoinWithoutSigningAnything(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := loginFake(t)
	a := founder(t, ctx, rs, "a", nil)
	bindTo(t, a, f, f.Key())
	y := joiner(t, ctx, rs, a.invite(t, time.Minute), "y")
	var r map[string]any
	if err := Call(a.st, Request{Op: "revoke", Subject: ident.B64.EncodeToString(y.id.SignPub)}, &r); err != nil {
		t.Fatal(err)
	}
	// a pushes only to current members; y hears of its revoke through any member it syncs with.
	if _, err := y.d.mesh().Merge(a.d.mesh().Records()); err != nil {
		t.Fatal(err)
	}
	y.d.viewChanged()
	if _, ok := y.d.view().Revoked[ident.B64.EncodeToString(y.id.SignPub)]; !ok {
		t.Fatal("setup: y has not heard of its revoke")
	}
	before := y.d.mesh().Len()
	j := newcomer(t)
	as := f.Issue(testSub, "me@example.com", j.SignPub, j.NoisePub, time.Now())
	// The registry still lists y; y.ls no longer counts it, so it is offered as the registry lists it.
	if _, _, err := AccountJoin(ctx, []string{rs.URL}, j, "j", as, []login.OfferedMember{listedAs(y, "y")}); err == nil {
		t.Fatal("a machine that is not a member admitted j")
	}
	if n := y.d.mesh().Len(); n != before {
		t.Fatalf("y signed %d record(s) for a join it could not make", n-before)
	}
}
