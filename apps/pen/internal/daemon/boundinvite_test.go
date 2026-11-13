package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/session"
	"github.com/goat-si/goat/apps/pen/internal/state"
	"github.com/goat-si/goat/apps/pen/internal/strictjson"
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
	clk := &clock{}
	clk.ms.Store(time.Now().UnixMilli())
	a := founder(t, ctx, rs, "a", clk)
	jst := shortDir(t)
	jid := identity(t, jst, rs.URL, "j")
	var r InviteReply
	if err := rawCall(t, a.st, fmt.Sprintf(`{"op":"invite","mintId":"m1","expiresAt":%d,"subject":%s}`, clk.now().Add(time.Minute).UnixMilli(), subjectLine(jid, "j")), &r); err != nil {
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
	if err := rawCall(t, a.st, fmt.Sprintf(`{"op":"invite","mintId":"m2","expiresAt":%d,"subject":%s}`, clk.now().Add(time.Minute).UnixMilli(), subjectLine(jid, "j")), &r); err == nil {
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
	clk := &clock{}
	clk.ms.Store(time.Now().UnixMilli())
	a := founder(t, ctx, rs, "a", clk)
	jid := newIdentity(t)
	var r InviteReply
	if err := rawCall(t, a.st, fmt.Sprintf(`{"op":"invite","mintId":"m1","expiresAt":%d,"subject":%s}`, clk.now().Add(time.Minute).UnixMilli(), subjectLine(jid, "j")), &r); err != nil {
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

// The status answer names the bound-invite features as its last member, and is otherwise exactly the answer an older
// node gives, so a caller can check support before it mints and older readers see nothing new but one member.
func TestStatusNamesTheBoundInviteFeatures(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	cl, err := Dial(a.st)
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()
	if err := cl.Send(Request{Op: "status"}); err != nil {
		t.Fatal(err)
	}
	var raw json.RawMessage
	if err := cl.Next(&raw); err != nil {
		t.Fatal(err)
	}
	const suffix = `,"features":["invite.subject/1","invite.cancel/1","invite.mint/1","invite.status/1"]}`
	var s Status
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	s.Features = nil
	old, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	if want := string(old[:len(old)-1]) + suffix; string(raw) != want {
		t.Fatalf("status answered\n%s\nwant\n%s", raw, want)
	}
}

// A caller that sends a subject member at all asked for a bound invite: a null or string subject is refused and makes
// nothing, never an ordinary token any machine could use.
func TestAnInviteWithANullOrStringSubjectIsRefused(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	for _, line := range []string{
		`{"op":"invite","subject":null}`,
		`{"op":"invite","subject":"x"}`,
		`{"op":"invite","ttlMs":60000,"subject":""}`,
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

// A caller waiting on an invite (wait:true) is told when the invite is cancelled and its connection ends, instead of
// waiting until the expiry and then answering expired.
func TestCancelEndsAWaitOnTheInvite(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	clk := &clock{}
	clk.ms.Store(time.Now().UnixMilli())
	a := founder(t, ctx, rs, "a", clk)
	jid := newIdentity(t)
	cl, err := Dial(a.st)
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()
	fmt.Fprintf(cl, "%s\n", fmt.Sprintf(`{"op":"invite","wait":true,"mintId":"m1","expiresAt":%d,"subject":%s}`, clk.now().Add(time.Hour).UnixMilli(), subjectLine(jid, "j")))
	var r InviteReply
	if err := cl.Next(&r); err != nil {
		t.Fatal(err)
	}
	var c InviteCancelReply
	if err := rawCall(t, a.st, `{"op":"invite.cancel","mintId":"m1"}`, &c); err != nil || c.State != "cancelled" {
		t.Fatalf("cancel: %+v, %v", c, err)
	}
	var ev struct{ T string }
	if err := cl.Next(&ev); err != nil || ev.T != "cancelled" {
		t.Fatalf("the waiting caller got %+v (%v); want cancelled", ev, err)
	}
}

// An ordinary invite's answer has exactly dev's members: bound invites add id and mintId only to their own answers.
func TestAnOrdinaryInvitesAnswerIsUnchanged(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	var raw json.RawMessage
	if err := Call(a.st, Request{Op: "invite", TTLMs: 60000}, &raw); err != nil {
		t.Fatal(err)
	}
	keys, err := strictjson.Keys(raw)
	if err != nil || strings.Join(keys, ",") != "token,relay,expiresAt,command,windowsCommand" {
		t.Fatalf("answer members %v (%v); want token,relay,expiresAt,command,windowsCommand", keys, err)
	}
}

// A cancel (and even its ack) that lands after a bound invite is made but before its waiter is registered still ends
// the wait: the invite's cancel signal is attached in the same step that makes it (Invites.CreateBoundNotify).
func TestACancelBeforeTheWaitIsRegisteredStillEndsIt(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	clk := &clock{}
	clk.ms.Store(time.Now().UnixMilli())
	a := founder(t, ctx, rs, "a", clk)
	// Between the create and the waiter: a cancel by mintId and its ack, which leave no trace of the invite.
	a.d.boundCreated = func(string) {
		var c InviteCancelReply
		if err := rawCall(t, a.st, `{"op":"invite.cancel","mintId":"m1"}`, &c); err != nil || c.State != "cancelled" {
			t.Errorf("cancel: %+v, %v", c, err)
		}
		if err := rawCall(t, a.st, `{"op":"invite.ack","mintId":"m1"}`, &c); err != nil || c.State != "acked" {
			t.Errorf("ack: %+v, %v", c, err)
		}
	}
	jid := newIdentity(t)
	cl, err := Dial(a.st)
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()
	fmt.Fprintf(cl, "%s\n", fmt.Sprintf(`{"op":"invite","wait":true,"mintId":"m1","expiresAt":%d,"subject":%s}`, clk.now().Add(time.Hour).UnixMilli(), subjectLine(jid, "j")))
	var r InviteReply
	if err := cl.Next(&r); err != nil {
		t.Fatal(err)
	}
	var ev struct{ T string }
	if err := cl.Next(&ev); err != nil || ev.T != "cancelled" {
		t.Fatalf("the waiting caller got %+v (%v); want cancelled", ev, err)
	}
}

// A caller waiting on an ordinary invite (pen invite) is told when invite.cancel removes it by id.
func TestCancelEndsAWaitOnAnOrdinaryInvite(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	cl, err := Dial(a.st)
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()
	if err := cl.Send(Request{Op: "invite", TTLMs: 3_600_000, Wait: true}); err != nil {
		t.Fatal(err)
	}
	var r InviteReply
	if err := cl.Next(&r); err != nil {
		t.Fatal(err)
	}
	tok, err := mesh.ParseToken(r.Token)
	if err != nil {
		t.Fatal(err)
	}
	var c InviteCancelReply
	if err := rawCall(t, a.st, `{"op":"invite.cancel","inviteId":"`+session.InviteID(tok.Secret)+`"}`, &c); err != nil || c.State != "cancelled" {
		t.Fatalf("cancel: %+v, %v", c, err)
	}
	var ev struct{ T string }
	if err := cl.Next(&ev); err != nil || ev.T != "cancelled" {
		t.Fatalf("the waiting caller got %+v (%v); want cancelled", ev, err)
	}
}

// recordsFail fails the inviter's sends once it starts sending the record set (tests).
type recordsFail struct{ mesh.Link }

func (l recordsFail) Send(p []byte) error {
	if bytes.Contains(p, []byte(`"t":"records"`)) {
		l.Link.Close(4400)
		return errors.New("send failed after the admit")
	}
	return l.Link.Send(p)
}

// A caller waiting on an invite whose join failed after the admit was signed hears that the joiner was admitted but
// did not receive the set, never that the invite expired; for a bound and an ordinary invite alike.
func TestAWaitHearsAnAdmissionWhoseJoinDidNotFinish(t *testing.T) {
	old := serveJoinLink
	serveJoinLink = func(l mesh.Link) mesh.Link { return recordsFail{l} }
	t.Cleanup(func() { serveJoinLink = old })
	for _, bound := range []bool{true, false} {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		rs := relaytest.New()
		defer rs.Close()
		clk := &clock{}
		clk.ms.Store(time.Now().UnixMilli())
		a := founder(t, ctx, rs, "a", clk)
		jst := shortDir(t)
		jid := identity(t, jst, rs.URL, "j")
		cl, err := Dial(a.st)
		if err != nil {
			t.Fatal(err)
		}
		defer cl.Close()
		if bound {
			fmt.Fprintf(cl, "%s\n", fmt.Sprintf(`{"op":"invite","wait":true,"mintId":"m1","expiresAt":%d,"subject":%s}`, clk.now().Add(time.Hour).UnixMilli(), subjectLine(jid, "j")))
		} else if err := cl.Send(Request{Op: "invite", TTLMs: 3_600_000, Wait: true}); err != nil {
			t.Fatal(err)
		}
		var r InviteReply
		if err := cl.Next(&r); err != nil {
			t.Fatal(err)
		}
		tok, _ := mesh.ParseToken(r.Token)
		if _, err := Join(ctx, jst, jid, tok, "j"); err == nil {
			t.Fatalf("bound %v: the join finished though the set was never sent", bound)
		}
		var ev struct {
			T         string
			Member    mesh.Member
			Delivered *bool
		}
		if err := cl.Next(&ev); err != nil || ev.T != "admitted" || ev.Delivered == nil || *ev.Delivered || ev.Member.NoisePub != ident.B64.EncodeToString(jid.NoisePub) {
			t.Fatalf("bound %v: the waiting caller got %+v (%v); want admitted with delivered false naming the joiner", bound, ev, err)
		}
	}
}

// The answer to a join that finished is exactly what it was before: members member and t.
func TestAFinishedJoinsWaitAnswerIsUnchanged(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	jst := shortDir(t)
	jid := identity(t, jst, rs.URL, "j")
	cl, err := Dial(a.st)
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()
	if err := cl.Send(Request{Op: "invite", TTLMs: 3_600_000, Wait: true}); err != nil {
		t.Fatal(err)
	}
	var r InviteReply
	if err := cl.Next(&r); err != nil {
		t.Fatal(err)
	}
	tok, _ := mesh.ParseToken(r.Token)
	if _, err := Join(ctx, jst, jid, tok, "j"); err != nil {
		t.Fatal(err)
	}
	var raw json.RawMessage
	if err := cl.Next(&raw); err != nil {
		t.Fatal(err)
	}
	if keys, err := strictjson.Keys(raw); err != nil || strings.Join(keys, ",") != "member,t" {
		t.Fatalf("admitted answer %s; want exactly the members member and t", raw)
	}
}

// holdRecords holds the inviter's records send until release is closed, after telling entered: the invite is burned
// and its join not finished (tests).
type holdRecords struct {
	mesh.Link
	entered chan<- struct{}
	release <-chan struct{}
}

func (l holdRecords) Send(p []byte) error {
	if bytes.Contains(p, []byte(`"t":"records"`)) {
		select {
		case l.entered <- struct{}{}:
		default:
		}
		<-l.release
	}
	return l.Link.Send(p)
}

// An invite used just before it expires is answered with its join's outcome, never expired, even when the expiry
// comes while that join is still running.
func TestAWaitOnAnInviteUsedBeforeItsExpiryHearsTheJoin(t *testing.T) {
	entered, release := make(chan struct{}, 1), make(chan struct{})
	oldLink, oldExpiry := serveJoinLink, inviteExpiry
	serveJoinLink = func(l mesh.Link) mesh.Link { return holdRecords{l, entered, release} }
	// Each timer is its own: the first is the invite's expiry, the second the wait for the join once it is used.
	timers := make(chan chan time.Time, 2)
	inviteExpiry = func(time.Duration) (<-chan time.Time, func() bool) {
		ch := make(chan time.Time)
		timers <- ch
		return ch, func() bool { return true }
	}
	t.Cleanup(func() { serveJoinLink, inviteExpiry = oldLink, oldExpiry })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	clk := &clock{}
	clk.ms.Store(time.Now().UnixMilli())
	a := founder(t, ctx, rs, "a", clk)
	jst := shortDir(t)
	jid := identity(t, jst, rs.URL, "j")
	cl, err := Dial(a.st)
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()
	fmt.Fprintf(cl, "%s\n", fmt.Sprintf(`{"op":"invite","wait":true,"mintId":"m1","expiresAt":%d,"subject":%s}`, clk.now().Add(time.Hour).UnixMilli(), subjectLine(jid, "j")))
	var r InviteReply
	if err := cl.Next(&r); err != nil {
		t.Fatal(err)
	}
	tok, _ := mesh.ParseToken(r.Token)
	joined := make(chan error, 1)
	go func() { _, err := Join(ctx, jst, jid, tok, "j"); joined <- err }()
	<-entered
	expiry := <-timers
	// The burned invite's join is held, so no outcome exists yet: either the caller takes the expiry now, or it saw
	// the burn first and has started waiting for the join.
	select {
	case expiry <- time.Now():
	case <-timers:
	}
	close(release)
	if err := <-joined; err != nil {
		t.Fatal(err)
	}
	var ev struct{ T string }
	if err := cl.Next(&ev); err != nil || ev.T != "admitted" {
		t.Fatalf("the waiting caller got %+v (%v); want admitted", ev, err)
	}
}

// A wait on an invite whose join used it and never reports is answered burned once that join's own time is up,
// counted from the burn, however far off the invite's expiry is.
func TestAWaitOnAUsedInviteWhoseJoinNeverReportsEnds(t *testing.T) {
	entered, release := make(chan struct{}, 1), make(chan struct{})
	oldLink, oldExpiry := serveJoinLink, inviteExpiry
	serveJoinLink = func(l mesh.Link) mesh.Link { return holdRecords{l, entered, release} }
	timers := make(chan chan time.Time, 2)
	inviteExpiry = func(time.Duration) (<-chan time.Time, func() bool) {
		ch := make(chan time.Time)
		timers <- ch
		return ch, func() bool { return true }
	}
	t.Cleanup(func() { serveJoinLink, inviteExpiry = oldLink, oldExpiry })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	clk := &clock{}
	clk.ms.Store(time.Now().UnixMilli())
	a := founder(t, ctx, rs, "a", clk)
	jst := shortDir(t)
	jid := identity(t, jst, rs.URL, "j")
	cl, err := Dial(a.st)
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()
	fmt.Fprintf(cl, "%s\n", fmt.Sprintf(`{"op":"invite","wait":true,"mintId":"m1","expiresAt":%d,"subject":%s}`, clk.now().Add(time.Hour).UnixMilli(), subjectLine(jid, "j")))
	var r InviteReply
	if err := cl.Next(&r); err != nil {
		t.Fatal(err)
	}
	tok, _ := mesh.ParseToken(r.Token)
	joined := make(chan error, 1)
	go func() { _, err := Join(ctx, jst, jid, tok, "j"); joined <- err }()
	// The held join is let go and drained before the test's directories are removed.
	defer func() { close(release); <-joined }()
	<-entered
	<-timers                 // the invite's expiry, an hour off, never fires
	(<-timers) <- time.Now() // the join's own time, counted from the burn, is up
	var ev struct{ T string }
	if err := cl.Next(&ev); err != nil || ev.T != "burned" {
		t.Fatalf("the waiting caller got %+v (%v); want burned", ev, err)
	}
}

// A wait's expiry timer runs on the monotonic clock and the invite expires by the node's clock. When the timer fires
// early by the node's clock (it was set back), the wait re-arms for the time left and later hears the subject's join;
// when it fires on time, the wait writes the expired entry and answers expired.
func TestAWaitDecidesItsExpiryByTheNodesClock(t *testing.T) {
	type timer struct {
		ch chan time.Time
		d  time.Duration
	}
	timers := make(chan timer, 4)
	oldExpiry := inviteExpiry
	inviteExpiry = func(d time.Duration) (<-chan time.Time, func() bool) {
		ch := make(chan time.Time)
		timers <- timer{ch, d}
		return ch, func() bool { return true }
	}
	t.Cleanup(func() { inviteExpiry = oldExpiry })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	clk := &clock{}
	clk.ms.Store(time.Now().UnixMilli())
	a := founder(t, ctx, rs, "a", clk)
	jst := shortDir(t)
	jid := identity(t, jst, rs.URL, "j")
	wait := func(m string) (*Client, InviteReply) {
		t.Helper()
		cl, err := Dial(a.st)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { cl.Close() })
		fmt.Fprintf(cl, "%s\n", fmt.Sprintf(`{"op":"invite","wait":true,"mintId":%q,"expiresAt":%d,"subject":%s}`, m, clk.now().Add(time.Minute).UnixMilli(), subjectLine(jid, "j")))
		var r InviteReply
		if err := cl.Next(&r); err != nil {
			t.Fatal(err)
		}
		return cl, r
	}

	cl, r := wait("early")
	type answer struct {
		t   string
		err error
	}
	answers := make(chan answer, 1)
	go func() {
		var ev struct{ T string }
		err := cl.Next(&ev)
		answers <- answer{ev.T, err}
	}()
	(<-timers).ch <- time.Now() // fires while the node's clock is still a minute short of the expiry
	select {
	case again := <-timers:
		if again.d != time.Minute {
			t.Fatalf("re-armed for %v; want the minute left by the node's clock", again.d)
		}
	case a := <-answers:
		t.Fatalf("at a timer a minute early by the node's clock the waiting caller got %q (%v); want it to wait again", a.t, a.err)
	}
	tok, _ := mesh.ParseToken(r.Token)
	if _, err := Join(ctx, jst, jid, tok, "j"); err != nil {
		t.Fatal(err)
	}
	if a := <-answers; a.err != nil || a.t != "admitted" {
		t.Fatalf("after an early timer the waiting caller got %q (%v); want admitted", a.t, a.err)
	}
	var ev struct{ T string }

	cl, _ = wait("late")
	clk.advance(2 * time.Minute)
	late := <-timers
	for late.d == meshSessionTimeout {
		late = <-timers // the first wait's timer for its join, which it may have started after the burn
	}
	late.ch <- time.Now()
	if err := cl.Next(&ev); err != nil || ev.T != "expired" {
		t.Fatalf("past its expiry the waiting caller got %+v (%v); want expired", ev, err)
	}
	var books []mesh.Invite
	if _, err := a.st.ReadJSON("offers.json", &books); err != nil {
		t.Fatal(err)
	}
	written := false
	for _, x := range books {
		written = written || x.MintID == "late" && x.State == "expired"
	}
	if !written {
		t.Fatalf("offers.json %+v; want the late invite written as expired before the answer", books)
	}
}

// A join outcome without a member (the invite was used and no admission can be named) is answered burned.
func TestAWaitHearsBurnedForAnOutcomeWithoutAMember(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	clk := &clock{}
	clk.ms.Store(time.Now().UnixMilli())
	a := founder(t, ctx, rs, "a", clk)
	jid := newIdentity(t)
	cl, err := Dial(a.st)
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()
	fmt.Fprintf(cl, "%s\n", fmt.Sprintf(`{"op":"invite","wait":true,"mintId":"m1","expiresAt":%d,"subject":%s}`, clk.now().Add(time.Hour).UnixMilli(), subjectLine(jid, "j")))
	var r InviteReply
	if err := cl.Next(&r); err != nil {
		t.Fatal(err)
	}
	a.d.tellWaiter(r.ID, joinOutcome{})
	var raw json.RawMessage
	if err := cl.Next(&raw); err != nil || string(raw) != `{"t":"burned"}` {
		t.Fatalf("the waiting caller got %s (%v); want exactly {\"t\":\"burned\"}", raw, err)
	}
}
