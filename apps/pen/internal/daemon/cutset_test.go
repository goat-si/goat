package daemon

import (
	"bytes"
	"context"
	"sort"
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
// machine the service listed, so the honest member that refuses j fails the join instead of j trusting
// x, also after j's check shows a its records: a holds x's compromised revoke, so they do not make j
// a member there.
func TestFinishJoinFailsWhenAListedMachineTheServedViewCallsRevokedRefusesThisOne(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := loginFake(t)
	a := founder(t, ctx, rs, "a", nil)
	x := joiner(t, ctx, rs, a.invite(t, time.Minute), "x")
	aPub := ident.B64.EncodeToString(a.d.id.SignPub)
	xPub := ident.B64.EncodeToString(x.d.id.SignPub)
	var res struct{ Results []PushResult }
	if err := Call(a.st, Request{Op: "revoke", Subject: xPub, Compromised: true}, &res); err != nil {
		t.Fatal(err)
	}
	// a binds only now, so x's copy never had the binding; a's check uses a's own.
	bindTo(t, a, f, f.Key())
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
	as := f.Issue(testSub, "me@example.com", jid.SignPub, jid.NoisePub, time.Now())
	_, _, err = FinishJoin(ctx, []string{rs.URL}, jid, s, listed, as)
	if err == nil || !strings.Contains(err.Error(), "a, listed for this account") {
		t.Fatalf("FinishJoin on x's cut copy: %v, want a refusal naming a", err)
	}
}

// The same cut copy from a machine revoked only plainly: x's revoke of a is ground to sort before
// a's revoke of x, so in the merged copy a is revoked and x admitted j. a never walks past x, which
// its own view revoked, so the join fails and says it may succeed after the members sync.
func TestFinishJoinFailsOnACutCopyFromAPlainlyRevokedMachineThatWonTheRevokeRace(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := loginFake(t)
	a := founder(t, ctx, rs, "a", nil)
	x := joiner(t, ctx, rs, a.invite(t, time.Minute), "x")
	aPub := ident.B64.EncodeToString(a.d.id.SignPub)
	xPub := ident.B64.EncodeToString(x.d.id.SignPub)
	// a revokes x plainly, and x, which never hears of it, revokes a over the same heads, as a
	// stolen key can. Both records are signed here, at varied times, until x's sorts first: each
	// pair does with probability one half, so 64 pairs fail by 2^-64.
	heads, aN, xN := headsOf(a.d.mesh()), counter(a.d.mesh(), aPub), counter(x.d.mesh(), xPub)
	var aRevokesX, xRevokesA *mesh.Record
	start := int64(1_800_000_000_000) // fixed record times; the keys stay random, so the pairs still vary
	for at := start; xRevokesA == nil && at < start+64; at++ {
		ra, err := mesh.Sign(a.d.id, a.d.mesh().MeshID, mesh.TypeRevoke, aN+1, heads, at, mesh.Fields{Subjects: []string{xPub}})
		if err != nil {
			t.Fatal(err)
		}
		rx, err := mesh.Sign(x.d.id, x.d.mesh().MeshID, mesh.TypeRevoke, xN+1, heads, at, mesh.Fields{Subjects: []string{aPub}})
		if err != nil {
			t.Fatal(err)
		}
		ha, _ := ident.B64.DecodeString(ra.Hash)
		hx, _ := ident.B64.DecodeString(rx.Hash)
		if bytes.Compare(hx, ha) < 0 {
			aRevokesX, xRevokesA = ra, rx
		}
	}
	if xRevokesA == nil {
		t.Fatal("setup: no pair in 64 made x's revoke sort before a's")
	}
	if _, err := a.d.mesh().Merge([]*mesh.Record{aRevokesX}); err != nil {
		t.Fatal(err)
	}
	a.d.viewChanged()
	bindTo(t, a, f, f.Key())
	if _, err := x.d.mesh().Merge([]*mesh.Record{xRevokesA}); err != nil {
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
	merged := mesh.Compute(s.MeshID, append(s.Records(), a.d.mesh().Records()...))
	if _, ok := merged.Members[ident.B64.EncodeToString(jid.SignPub)]; !ok {
		t.Fatal("setup: j is not a member once a's records are merged; x's revoke did not win")
	}
	listed := []login.OfferedMember{
		{NodeID: a.d.NodeID(), SignPub: aPub, NoisePub: ident.B64.EncodeToString(a.d.id.NoisePub), Name: "a"},
		{NodeID: x.d.NodeID(), SignPub: xPub, NoisePub: ident.B64.EncodeToString(x.d.id.NoisePub), Name: "x"},
	}
	as := f.Issue(testSub, "me@example.com", jid.SignPub, jid.NoisePub, time.Now())
	_, _, err = FinishJoin(ctx, []string{rs.URL}, jid, s, listed, as)
	if err == nil || !strings.Contains(err.Error(), "a, listed for this account") || !strings.Contains(err.Error(), "again") {
		t.Fatalf("FinishJoin on a plainly revoked machine's cut copy: %v, want a refusal naming a that says to try again", err)
	}
}

// headsOf are the records of s that no other record names in its prev.
func headsOf(s *mesh.Store) []string {
	referenced := map[string]bool{}
	for _, r := range s.Records() {
		for _, p := range r.B.Prev {
			referenced[p] = true
		}
	}
	var heads []string
	for _, r := range s.Records() {
		if !referenced[r.Hash] {
			heads = append(heads, r.Hash)
		}
	}
	sort.Strings(heads)
	return heads
}

// counter is the highest record counter by has signed in s.
func counter(s *mesh.Store, by string) uint64 {
	var n uint64
	for _, r := range s.Records() {
		if r.B.By == by {
			n = max(n, r.B.N)
		}
	}
	return n
}
