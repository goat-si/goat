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

// A machine that left (or was revoked plainly) and then turns out to have been stolen must still be
// revocable as compromised, or the keys it admitted and the binding it signed keep their effect.
func TestAMachineThatAlreadyLeftCanStillBeRevokedAsCompromised(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	c := joiner(t, ctx, rs, a.invite(t, time.Minute), "c")
	e := joiner(t, ctx, rs, c.invite(t, time.Minute), "e")
	cPub := ident.B64.EncodeToString(c.d.id.SignPub)
	ePub := ident.B64.EncodeToString(e.d.id.SignPub)
	key := mesh.LoginKey{Kid: login.Kid(c.d.id.NoisePub), Pub: ident.B64.EncodeToString(c.d.id.NoisePub)}
	acct := &mesh.Account{LoginURL: "https://login.example", LoginKey: key, Sub: "1001"}
	if _, err := c.d.mesh().Append(c.d.id, mesh.TypeAccount, time.Now().UnixMilli(), mesh.Fields{Bind: acct}); err != nil {
		t.Fatal(err)
	}
	c.d.viewChanged()
	c.d.pushAll(ctx)
	if got := a.ls(t).Account; got == nil || got.Sub != "1001" {
		t.Fatalf("a's binding after c bound: %+v", got)
	}
	var left struct{ Results []PushResult }
	if err := Call(c.st, Request{Op: "leave"}, &left); err != nil {
		t.Fatal(err)
	}
	<-c.done
	c.done <- nil

	var res struct{ Results []PushResult }
	if err := Call(a.st, Request{Op: "revoke", Subject: cPub, Compromised: true}, &res); err != nil {
		t.Fatalf("revoking c as compromised after it left: %v", err)
	}
	v := a.d.view()
	if _, ok := v.Revoked[ePub]; !ok {
		t.Fatal("e, admitted by c, is still a member")
	}
	if v.Account != nil {
		t.Fatalf("the binding c signed still holds: %+v", v.Account)
	}
	if err := Call(a.st, Request{Op: "revoke", Subject: cPub}, &res); err == nil {
		t.Fatal("a plain revoke of a key already revoked was accepted")
	}
}
