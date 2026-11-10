package cli

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

// pen revoke --compromised names a machine that already left by its name, as pen ls showed it.
func TestRevokeCompromisedFindsAMachineThatAlreadyLeftByName(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a, b := meshOfTwo(t, ctx, rs)
	var left struct{ Results []daemon.PushResult }
	if err := daemon.Call(b, daemon.Request{Op: "leave"}, &left); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PEN_HOME", a.Dir)
	var out, errOut bytes.Buffer
	if code := RunRevoke([]string{"b"}, &out, &errOut); code == 0 {
		t.Fatal("a plain revoke of a machine that already left succeeded")
	}
	errOut.Reset()
	if code := RunRevoke([]string{"--compromised", "b"}, &out, &errOut); code != 0 {
		t.Fatalf("pen revoke --compromised b after b left: exit %d: %s", code, errOut.String())
	}
}

// A departed machine and a current one can share a name. Revoking that name as compromised must
// not pick one: it fails, names both machines, and revokes neither.
func TestRevokeCompromisedRefusesANameADepartedAndACurrentMachineShare(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a, b := meshOfTwo(t, ctx, rs)
	bid, _, _ := b.EnsureIdentity()
	var res struct{ Results []daemon.PushResult }
	if err := daemon.Call(a, daemon.Request{Op: "revoke", Subject: ident.B64.EncodeToString(bid.SignPub)}, &res); err != nil {
		t.Fatal(err)
	}
	var inv struct{ Token string }
	if err := daemon.Call(a, daemon.Request{Op: "invite", TTLMs: 60000}, &inv); err != nil {
		t.Fatal(err)
	}
	tok, _ := mesh.ParseToken(inv.Token)
	b2 := tmpStore(t)
	b2id, _, _ := b2.EnsureIdentity()
	b2.SaveConfig(state.Config{Relay: rs.URL, Name: "b"})
	s, err := daemon.Join(ctx, b2, b2id, tok, "b")
	if err != nil {
		t.Fatal(err)
	}
	s.Save()
	startNode(t, ctx, rs, b2)
	t.Setenv("PEN_HOME", a.Dir)
	var out, errOut bytes.Buffer
	if code := RunRevoke([]string{"--compromised", "b"}, &out, &errOut); code == 0 {
		t.Fatalf("pen revoke --compromised b revoked one of two machines named b: %s", out.String())
	}
	for _, id := range []string{bid.NodeID(), b2id.NodeID()} {
		if !strings.Contains(errOut.String(), id) {
			t.Fatalf("the refusal does not name %s: %s", id, errOut.String())
		}
	}
	var ls daemon.LsReply
	if err := daemon.Call(a, daemon.Request{Op: "ls"}, &ls); err != nil {
		t.Fatal(err)
	}
	if _, err := Resolve(lsMembers(ls), b2id.NodeID()); err != nil {
		t.Fatalf("the current b is no longer a member: %v", err)
	}
}
