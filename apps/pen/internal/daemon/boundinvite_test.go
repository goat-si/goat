package daemon

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

// rawCall sends one control line as written and decodes one answer.
func rawCall(t *testing.T, st *state.Store, line string, v any) error {
	t.Helper()
	cl, err := Dial(st)
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()
	if _, err := cl.Write([]byte(line + "\n")); err != nil {
		t.Fatal(err)
	}
	return cl.Next(v)
}

func subjectLine(id *ident.Identity, name string) string {
	return fmt.Sprintf(`{"signPub":%q,"noisePub":%q,"name":%q}`, ident.B64.EncodeToString(id.SignPub), ident.B64.EncodeToString(id.NoisePub), name)
}

// Over the control socket, an invite op with a subject answers the invite's id and admits only that machine.
func TestBoundInviteOpAdmitsOnlyItsSubject(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	jst := shortDir(t)
	jid := identity(t, jst, rs.URL, "j")
	var r InviteReply
	if err := rawCall(t, a.st, `{"op":"invite","ttlMs":60000,"subject":`+subjectLine(jid, "j")+`}`, &r); err != nil {
		t.Fatal(err)
	}
	tok, err := mesh.ParseToken(r.Token)
	if err != nil || r.ID == "" {
		t.Fatalf("answer %+v (%v); want a token and the invite id", r, err)
	}
	var refused *mesh.RefusedError
	if _, err := Join(ctx, jst, jid, tok, "k"); !errors.As(err, &refused) {
		t.Fatalf("join under another name: %v; want a refusal", err)
	}
	if _, err := Join(ctx, jst, jid, tok, "j"); err != nil {
		t.Fatalf("the subject's join after the refusal: %v", err)
	}
	if got := names(a.ls(t).Members); got != "a,j" {
		t.Fatalf("members %s; want a,j", got)
	}
}

// A subject that is not exactly three valid members is refused and makes no invite.
func TestBoundInviteOpRefusesAMalformedSubject(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	jid := newIdentity(t)
	good := subjectLine(jid, "j")
	for _, line := range []string{
		`{"op":"invite","subject":{"signPub":"x","noisePub":"y","name":"j"}}`,
		`{"op":"invite","subject":` + good[:len(good)-1] + `,"extra":1}}`,
		`{"op":"invite","subject":` + good + `,"mintid":"m"}`,
		`{"op":"invite","subject":{"signPub":"` + ident.B64.EncodeToString(jid.SignPub) + `","noisePub":"` + ident.B64.EncodeToString(jid.NoisePub) + `","name":"Not A Name"}}`,
	} {
		var r InviteReply
		if err := rawCall(t, a.st, line, &r); err == nil {
			t.Fatalf("%s: answered %+v; want a refusal", line, r)
		}
	}
	var offers []mesh.Invite
	if _, err := a.st.ReadJSON("offers.json", &offers); err != nil || len(offers) != 0 {
		t.Fatalf("offers.json holds %d invite(s) (%v); want none", len(offers), err)
	}
}

func newIdentity(t *testing.T) *ident.Identity {
	t.Helper()
	id, err := ident.Generate(nil)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// Over the control socket, invite.cancel ends a bound invite by its mintId or id, answers the state it is in, and a
// cancel of a mintId nothing made yet refuses that create later.
func TestInviteCancelOpEndsABoundInviteAndFencesAMint(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	jst := shortDir(t)
	jid := identity(t, jst, rs.URL, "j")
	var r InviteReply
	if err := rawCall(t, a.st, `{"op":"invite","ttlMs":60000,"mintId":"m1","subject":`+subjectLine(jid, "j")+`}`, &r); err != nil {
		t.Fatal(err)
	}
	if r.MintID != "m1" || r.ID == "" {
		t.Fatalf("answer %+v; want the id and mintId m1", r)
	}
	cancelOp := func(line string) InviteCancelReply {
		t.Helper()
		var c InviteCancelReply
		if err := rawCall(t, a.st, line, &c); err != nil {
			t.Fatalf("%s: %v", line, err)
		}
		return c
	}
	if c := cancelOp(`{"op":"invite.cancel","mintId":"m1"}`); c.State != "cancelled" {
		t.Fatalf("cancel by mintId: %+v", c)
	}
	tok, _ := mesh.ParseToken(r.Token)
	if _, err := Join(ctx, jst, jid, tok, "j"); err == nil {
		t.Fatal("the subject joined with a cancelled invite")
	}
	if c := cancelOp(`{"op":"invite.cancel","inviteId":"` + r.ID + `"}`); c.State != "cancelled" {
		t.Fatalf("second cancel by id: %+v", c)
	}
	if c := cancelOp(`{"op":"invite.cancel","mintId":"m2"}`); c.State != "cancelled" {
		t.Fatalf("cancel of an unmade mint: %+v", c)
	}
	if err := rawCall(t, a.st, `{"op":"invite","mintId":"m2","subject":`+subjectLine(jid, "j")+`}`, &r); err == nil {
		t.Fatalf("the fenced mint made an invite: %+v", r)
	}
	if c := cancelOp(`{"op":"invite.cancel","inviteId":"AAAAAAAAAAAAAAAA"}`); c.State != "absent" {
		t.Fatalf("cancel of an unknown id: %+v", c)
	}
	var c InviteCancelReply
	if err := rawCall(t, a.st, `{"op":"invite.cancel","inviteId":"AAAAAAAAAAAAAAAA","mintId":"m3"}`, &c); err == nil {
		t.Fatalf("a cancel naming both an id and a mintId answered %+v", c)
	}
}
