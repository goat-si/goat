package daemon

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/login"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/session"
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

// J1: a still-listed machine that is not a member answers first and refuses; the join goes on
// through the healthy listed member within the same call.
func TestAGoogleJoinGoesOnPastAListedMachineThatIsNotAMember(t *testing.T) {
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
	if _, err := y.d.mesh().Merge(a.d.mesh().Records()); err != nil {
		t.Fatal(err)
	}
	y.d.viewChanged()
	// y's handshake finishes before a is even dialed.
	yDone := make(chan struct{})
	var once sync.Once
	raceHooks.before = func(id string) {
		if id == a.d.NodeID() {
			<-yDone
		}
	}
	raceHooks.after = func(id string) {
		if id == y.d.NodeID() {
			once.Do(func() { close(yDone) })
		}
	}
	t.Cleanup(func() { raceHooks.before, raceHooks.after = nil, nil })
	j := newcomer(t)
	as := f.Issue(testSub, "me@example.com", j.SignPub, j.NoisePub, time.Now())
	out, by, err := AccountJoin(ctx, []string{rs.URL}, j, "j", as, []login.OfferedMember{listedAs(y, "y"), listedAs(a, "a")})
	if err != nil {
		t.Fatalf("the join stopped at the listed machine that is not a member: %v", err)
	}
	if by.NodeID != a.d.NodeID() || out.MeshID != a.d.mesh().MeshID {
		t.Fatalf("joined through %s into %s, want a's mesh through a", by.Name, out.MeshID)
	}
}

// J2: an inviter that is no longer a member refuses the joiner before the invite is burned, so
// nothing is signed and the invite stays as it was.
func TestAnInviterThatIsNotAMemberRefusesAndKeepsTheInvite(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	x := joiner(t, ctx, rs, a.invite(t, time.Minute), "x")
	var r map[string]any
	if err := Call(a.st, Request{Op: "revoke", Subject: ident.B64.EncodeToString(x.id.SignPub)}, &r); err != nil {
		t.Fatal(err)
	}
	if _, err := x.d.mesh().Merge(a.d.mesh().Records()); err != nil {
		t.Fatal(err)
	}
	x.d.viewChanged()
	tok := x.invite(t, time.Minute)
	before := x.d.mesh().Len()
	jst := shortDir(t)
	jid := identity(t, jst, rs.URL, "j")
	if _, err := Join(ctx, jst, jid, tok, "j"); err == nil || !strings.Contains(err.Error(), "no longer a member") {
		t.Fatalf("join through an inviter that is not a member: %v", err)
	}
	if n := x.d.mesh().Len(); n != before {
		t.Fatalf("the inviter signed %d record(s)", n-before)
	}
	if _, ok := x.d.invites.Lookup(session.InviteID(tok.Secret), time.Now()); !ok {
		t.Fatal("the invite was burned by a join that could not happen")
	}
}

// J2: approve on a machine that stopped being a member after it queued the request refuses
// without signing.
func TestApproveOnAMachineThatIsNotAMemberRefuses(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := loginFake(t)
	a := founder(t, ctx, rs, "a", nil)
	bindTo(t, a, f, f.Key())
	y := joiner(t, ctx, rs, a.invite(t, time.Minute), "y")
	var r map[string]any
	if err := Call(a.st, Request{Op: "lock", On: true}, &r); err != nil {
		t.Fatal(err)
	}
	if !y.d.view().Locked {
		t.Fatal("setup: y has not heard of the lock")
	}
	j := newcomer(t)
	as := f.Issue(testSub, "me@example.com", j.SignPub, j.NoisePub, time.Now())
	out, _, err := AccountJoin(ctx, []string{rs.URL}, j, "j", as, offeredBy(t, y))
	if err != nil || out.QueuedBy != "y" {
		t.Fatalf("setup: queue on y: %+v %v", out, err)
	}
	if err := Call(a.st, Request{Op: "revoke", Subject: ident.B64.EncodeToString(y.id.SignPub)}, &r); err != nil {
		t.Fatal(err)
	}
	if _, err := y.d.mesh().Merge(a.d.mesh().Records()); err != nil {
		t.Fatal(err)
	}
	y.d.viewChanged()
	before := y.d.mesh().Len()
	var ar ApproveResult
	if err := Call(y.st, Request{Op: "approve", Subject: ident.Fingerprint(j.NoisePub)}, &ar); err == nil || !strings.Contains(err.Error(), "not a member") {
		t.Fatalf("approve on a machine that is not a member: %v", err)
	}
	if n := y.d.mesh().Len(); n != before {
		t.Fatalf("y signed %d record(s)", n-before)
	}
}
