package daemon

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

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
	// Another machine holding the token is turned away at the handshake, before it can hold a join session open.
	ost := shortDir(t)
	other := identity(t, ost, rs.URL, "o")
	if _, err := Join(ctx, ost, other, tok, "j"); err == nil || errors.As(err, &refused) {
		t.Fatalf("join by another machine: %v; want it closed at the handshake, before any card", err)
	}
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
	if err := rawCall(t, a.st, fmt.Sprintf(`{"op":"invite","mintId":"m1","expiresAt":%d,"subject":%s}`, time.Now().Add(time.Minute).UnixMilli(), subjectLine(jid, "j")), &r); err != nil {
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
	if err := rawCall(t, a.st, fmt.Sprintf(`{"op":"invite","mintId":"m2","expiresAt":%d,"subject":%s}`, time.Now().Add(time.Minute).UnixMilli(), subjectLine(jid, "j")), &r); err == nil {
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

// statusOp sends invite.status for ref (an inviteId or mintId line fragment) and decodes the answer.
func statusOp(t *testing.T, st *state.Store, ref string) mesh.InviteStatus {
	t.Helper()
	var s mesh.InviteStatus
	if err := rawCall(t, st, `{"op":"invite.status",`+ref+`}`, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

// Over the control socket a minted invite (mintId and an absolute expiresAt) is followed by invite.status from live to
// burned, naming the admit and that the subject is a member, until invite.ack forgets it; another one expires on the
// node's clock; and a mint whose expiresAt passed, is too far ahead, or lacks its mintId makes nothing.
func TestInviteStatusOpFollowsAMintToItsAdmitAndAck(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	clk := &clock{}
	clk.ms.Store(time.Now().UnixMilli())
	a := founder(t, ctx, rs, "a", clk)
	jst := shortDir(t)
	jid := identity(t, jst, rs.URL, "j")
	mint := func(m string, expiresAt time.Time) (InviteReply, error) {
		var r InviteReply
		err := rawCall(t, a.st, fmt.Sprintf(`{"op":"invite","mintId":%q,"expiresAt":%d,"subject":%s}`, m, expiresAt.UnixMilli(), subjectLine(jid, "j")), &r)
		return r, err
	}
	r, err := mint("m1", clk.now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if r.ExpiresAt != clk.now().Add(time.Minute).UnixMilli() {
		t.Fatalf("expiresAt %d; want the caller's %d", r.ExpiresAt, clk.now().Add(time.Minute).UnixMilli())
	}
	if s := statusOp(t, a.st, `"mintId":"m1"`); s.State != "live" || s.InviteID != r.ID {
		t.Fatalf("before the join: %+v", s)
	}
	tok, _ := mesh.ParseToken(r.Token)
	if _, err := Join(ctx, jst, jid, tok, "j"); err != nil {
		t.Fatal(err)
	}
	s := statusOp(t, a.st, `"inviteId":"`+r.ID+`"`)
	if s.State != "burned" || s.Nonce == "" || s.Admit == "" || s.Member == nil || !*s.Member || s.MintID != "m1" {
		t.Fatalf("after the join: %+v; want burned with nonce, admit and member", s)
	}
	var ack InviteCancelReply
	if err := rawCall(t, a.st, `{"op":"invite.ack","mintId":"m1"}`, &ack); err != nil || ack.State != "acked" {
		t.Fatalf("ack: %+v, %v", ack, err)
	}
	if s := statusOp(t, a.st, `"mintId":"m1"`); s.State != "absent" {
		t.Fatalf("after the ack: %+v", s)
	}

	if _, err := mint("m2", clk.now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	clk.advance(2 * time.Minute)
	if s := statusOp(t, a.st, `"mintId":"m2"`); s.State != "expired" {
		t.Fatalf("past its expiresAt: %+v", s)
	}
	for _, line := range []string{
		fmt.Sprintf(`{"op":"invite","mintId":"m3","expiresAt":%d,"subject":%s}`, clk.now().UnixMilli(), subjectLine(jid, "j")),
		fmt.Sprintf(`{"op":"invite","mintId":"m4","expiresAt":%d,"subject":%s}`, clk.now().Add(25*time.Hour).UnixMilli(), subjectLine(jid, "j")),
		fmt.Sprintf(`{"op":"invite","mintId":"m5","subject":%s}`, subjectLine(jid, "j")),
		fmt.Sprintf(`{"op":"invite","mintId":"m6","expiresAt":%d,"ttlMs":60000,"subject":%s}`, clk.now().Add(time.Minute).UnixMilli(), subjectLine(jid, "j")),
		fmt.Sprintf(`{"op":"invite","mintId":"m7","expiresAt":%d}`, clk.now().Add(time.Minute).UnixMilli()),
		fmt.Sprintf(`{"op":"invite","mintId":"m8","expiresAt":%d,"ttlMs":0,"subject":%s}`, clk.now().Add(time.Minute).UnixMilli(), subjectLine(jid, "j")),
		fmt.Sprintf(`{"op":"invite","mintId":"m9","expiresAt":%d,"ttlMs":null,"subject":%s}`, clk.now().Add(time.Minute).UnixMilli(), subjectLine(jid, "j")),
		fmt.Sprintf(`{"op":"invite","mintId":"m10","expiresAt":null,"ttlMs":60000,"subject":%s}`, subjectLine(jid, "j")),
		fmt.Sprintf(`{"op":"invite","mintId":"m11","expiresAt":0,"subject":%s}`, subjectLine(jid, "j")),
		fmt.Sprintf(`{"op":"invite","expiresAt":null,"subject":%s}`, subjectLine(jid, "j")),
		fmt.Sprintf(`{"op":"invite","expiresAt":0,"subject":%s}`, subjectLine(jid, "j")),
		fmt.Sprintf(`{"op":"invite","mintId":"","expiresAt":%d,"subject":%s}`, clk.now().Add(time.Minute).UnixMilli(), subjectLine(jid, "j")),
	} {
		var r InviteReply
		if err := rawCall(t, a.st, line, &r); err == nil {
			t.Fatalf("%s: made %+v; want a refusal", line, r)
		}
	}
	for _, m := range []string{"m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10", "m11"} {
		if s := statusOp(t, a.st, `"mintId":"`+m+`"`); s.State != "absent" {
			t.Fatalf("refused mint %s left %+v", m, s)
		}
	}
}

// Cancel, status and ack name exactly one member, inviteId or mintId: a line carrying both is refused even when one
// of them is empty, and nothing is cancelled or fenced.
func TestInviteRefOpsRefuseALineCarryingBothReferences(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	jid := newIdentity(t)
	var r InviteReply
	if err := rawCall(t, a.st, fmt.Sprintf(`{"op":"invite","mintId":"m1","expiresAt":%d,"subject":%s}`, time.Now().Add(time.Minute).UnixMilli(), subjectLine(jid, "j")), &r); err != nil {
		t.Fatal(err)
	}
	for _, op := range []string{"invite.cancel", "invite.status", "invite.ack"} {
		for _, refs := range []string{`"inviteId":"` + r.ID + `","mintId":""`, `"mintId":"fresh","inviteId":""`, `"inviteId":""`, `"mintId":""`} {
			line := `{"op":"` + op + `",` + refs + "}"
			var out map[string]any
			if err := rawCall(t, a.st, line, &out); err == nil {
				t.Fatalf("%s answered %v; want a refusal", line, out)
			}
		}
	}
	if s := statusOp(t, a.st, `"mintId":"m1"`); s.State != "live" {
		t.Fatalf("the invite after the refused lines: %+v; want live", s)
	}
	if s := statusOp(t, a.st, `"mintId":"fresh"`); s.State != "absent" {
		t.Fatalf("a refused cancel left a fence: %+v", s)
	}
}
