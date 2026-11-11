package daemon

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/session"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

type pairFixture struct {
	ctx  context.Context
	rs   *relaytest.Server
	a    *node
	clk  *clock
	prog *program
	h    *holder
}

func newPairFixture(t *testing.T) *pairFixture {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	rs := relaytest.New()
	t.Cleanup(rs.Close)
	clk := &clock{}
	clk.ms.Store(time.Now().UnixMilli())
	a := founder(t, ctx, rs, "a", clk)
	key := newKey(t)
	prog := newProgram(t, "goat", key)
	prog.serve()
	return &pairFixture{ctx: ctx, rs: rs, a: a, clk: clk, prog: prog, h: register(t, a, "goat", prog.port(), key)}
}

// invite opens a service invite and returns its id and psk.
func (f *pairFixture) invite(t *testing.T, id string) []byte {
	t.Helper()
	psk := newKey(t)
	if m := f.h.op(t, inviteOp(id, ident.B64.EncodeToString(psk), f.clk.ms.Load()+5*60_000)); m["t"] != "invite" {
		t.Fatalf("invite answered %v", m)
	}
	return psk
}

func servicePair(id string) session.Payload {
	return session.Payload{V: 1, Stream: "service-pair", Invite: id, Name: "goat"}
}

// pair sends a service-pair message 1 and returns the handshake once message 2 verified.
func (f *pairFixture) pair(t *testing.T, who *ident.Identity, psk []byte, p any) (*session.Pending, error) {
	t.Helper()
	conn, err := relay.Dial(f.ctx, f.rs.URL, f.a.d.NodeID())
	if err != nil {
		t.Fatal(err)
	}
	return session.InitiateHandshake(f.ctx, conn, session.KindJoin, f.a.d.NodeID(), f.a.id.NoisePub, who, psk, p)
}

// event reads the holder's next line and requires it to be t for id.
func (f *pairFixture) event(t *testing.T, kind, id string) {
	t.Helper()
	m, ok := f.h.next(t)
	if !ok || m["t"] != kind || m["id"] != id {
		t.Fatalf("holder got %v, want %s for %s", m, kind, id)
	}
}

func TestFourPairingHandshakesAreAnsweredTheFifthIsRefusedAndABurnAfterExhaustionStillWins(t *testing.T) {
	f := newPairFixture(t)
	id := "PPPPPPPPPPPPPPPP"
	psk := f.invite(t, id)
	var ps []*session.Pending
	for i := range 4 {
		p, err := f.pair(t, phone(t), psk, servicePair(id))
		if err != nil {
			t.Fatalf("handshake %d: %v, want message 2", i+1, err)
		}
		ps = append(ps, p)
	}
	f.event(t, "invite-exhausted", id)
	if _, err := f.pair(t, phone(t), psk, servicePair(id)); relay.CodeOf(err) != wire.CodeNotAdmitted {
		t.Fatalf("a fifth handshake got %v, want 4401 with no message 2", err)
	}
	sec, err := ps[2].Confirm()
	if err != nil {
		t.Fatal(err)
	}
	f.event(t, "invite-burned", id)
	if err := echo(f.ctx, sec, "pair"); err != nil {
		t.Fatalf("the winner's stream: %v", err)
	}
	var j struct {
		Pairing *struct{ Invite, NoisePub, Sas string }
	}
	if err := json.Unmarshal(<-f.prog.identities, &j); err != nil || j.Pairing == nil {
		t.Fatalf("pairing identity %+v, %v", j, err)
	}
	if want := ident.B64.EncodeToString(session.PairSAS(sec.HandshakeHash)); j.Pairing.Sas != want || j.Pairing.Invite != id {
		t.Fatalf("pairing line %+v; want invite %s and the sas of the winner's handshake %s", j.Pairing, id, want)
	}
	loser, err := ps[0].Confirm()
	if err == nil {
		if code := closedWith(f.ctx, loser); code != wire.CodeNotAdmitted {
			t.Fatalf("a second confirmation closed %d, want 4401 (one burn)", code)
		}
	}
	if m := f.h.op(t, cancelOp(id)); m["was"] != "burned" {
		t.Fatalf("cancel after the burn answered %v", m)
	}
}

// replayConn records the messages a handshake sends.
type replayConn struct {
	relay.Conn
	sent [][]byte
}

func (r *replayConn) Send(p []byte) error {
	r.sent = append(r.sent, append([]byte(nil), p...))
	return r.Conn.Send(p)
}

func TestAReplayedMessage1SpendsTheBudgetButCannotConfirm(t *testing.T) {
	f := newPairFixture(t)
	id := "RRRRRRRRRRRRRRRR"
	psk := f.invite(t, id)
	conn, err := relay.Dial(f.ctx, f.rs.URL, f.a.d.NodeID())
	if err != nil {
		t.Fatal(err)
	}
	rec := &replayConn{Conn: conn}
	genuine, err := session.InitiateHandshake(f.ctx, rec, session.KindJoin, f.a.d.NodeID(), f.a.id.NoisePub, phone(t), psk, servicePair(id))
	if err != nil {
		t.Fatal(err)
	}
	for range 2 { // a relay replays the captured message 1 twice
		r, err := relay.Dial(f.ctx, f.rs.URL, f.a.d.NodeID())
		if err != nil {
			t.Fatal(err)
		}
		if err := r.Send(rec.sent[0]); err != nil {
			t.Fatal(err)
		}
		if _, err := r.Recv(f.ctx); err != nil {
			t.Fatalf("the node did not answer a replay: %v", err)
		}
		forged := make([]byte, 32)
		rand.Read(forged)
		r.Send(forged) // the replayer cannot make the key confirmation
		if _, err := r.Recv(f.ctx); relay.CodeOf(err) != wire.CodeCrypto {
			t.Fatalf("a forged confirmation got %v, want 4400", err)
		}
	}
	if _, err := f.pair(t, phone(t), psk, servicePair(id)); err != nil {
		t.Fatalf("the fourth answer: %v", err)
	}
	f.event(t, "invite-exhausted", id)
	if _, err := genuine.Confirm(); err != nil {
		t.Fatal(err)
	}
	f.event(t, "invite-burned", id) // the replays burned nothing
}

func TestAPairingHandshakeCannotBurnAnInviteThatWasReplacedCancelledOrExpired(t *testing.T) {
	f := newPairFixture(t)
	burnRefused := func(why string, p *session.Pending) {
		t.Helper()
		t.Log(why)
		refusedAtConfirmation(t, f.ctx, p)
	}
	psk := f.invite(t, "AAAAAAAAAAAAAAAA")
	p, err := f.pair(t, phone(t), psk, servicePair("AAAAAAAAAAAAAAAA"))
	if err != nil {
		t.Fatal(err)
	}
	psk2 := f.invite(t, "BBBBBBBBBBBBBBBB")
	burnRefused("replaced", p)
	if _, err := f.pair(t, phone(t), psk, servicePair("AAAAAAAAAAAAAAAA")); relay.CodeOf(err) != wire.CodeNotAdmitted {
		t.Fatalf("the replaced invite's id got %v, want 4401", err)
	}
	if _, err := f.pair(t, phone(t), psk, servicePair("BBBBBBBBBBBBBBBB")); !errors.Is(err, session.ErrBadMessage2) {
		t.Fatalf("the old psk on the new invite got %v, want a message 2 that does not verify", err)
	}
	p, err = f.pair(t, phone(t), psk2, servicePair("BBBBBBBBBBBBBBBB"))
	if err != nil {
		t.Fatal(err)
	}
	if m := f.h.op(t, cancelOp("BBBBBBBBBBBBBBBB")); m["was"] != "live" {
		t.Fatalf("cancel answered %v", m)
	}
	burnRefused("cancelled", p)
	psk3 := f.invite(t, "CCCCCCCCCCCCCCCC")
	p, err = f.pair(t, phone(t), psk3, servicePair("CCCCCCCCCCCCCCCC"))
	if err != nil {
		t.Fatal(err)
	}
	f.clk.advance(6 * time.Minute)
	burnRefused("expired", p)
}

func TestMeshInvitesAndServiceInvitesNeverMatchEachOthersHandshake(t *testing.T) {
	f := newPairFixture(t)
	tok := f.a.invite(t, time.Minute)
	meshID := session.InviteID(tok.Secret)
	psk, _ := session.JoinPSK(tok.Secret, f.a.d.NodeID(), f.a.id.NoisePub)
	if _, err := f.pair(t, phone(t), psk, servicePair(meshID)); relay.CodeOf(err) != wire.CodeNotAdmitted {
		t.Fatalf("a mesh invite on service-pair got %v, want 4401", err)
	}
	spsk := f.invite(t, "SSSSSSSSSSSSSSSS")
	if _, err := f.pair(t, phone(t), spsk, session.Payload{V: 1, Stream: "join", Invite: "SSSSSSSSSSSSSSSS", Name: "x"}); relay.CodeOf(err) != wire.CodeNotAdmitted {
		t.Fatalf("a service invite on join got %v, want 4401", err)
	}
}

func TestAListChangeNeverClosesAPairingSessionAndTheRegistrationsEndDoes(t *testing.T) {
	f := newPairFixture(t)
	k := phone(t)
	f.h.setList(t, 1, k)
	csec, err := dialAs(f.ctx, f.rs, k, f.a, goatService())
	if err != nil {
		t.Fatal(err)
	}
	if err := echo(f.ctx, csec, "c"); err != nil {
		t.Fatal(err)
	}
	psk := f.invite(t, "KKKKKKKKKKKKKKKK")
	p, err := f.pair(t, k, psk, servicePair("KKKKKKKKKKKKKKKK")) // the same static key pairs
	if err != nil {
		t.Fatal(err)
	}
	psec, err := p.Confirm()
	if err != nil {
		t.Fatal(err)
	}
	f.event(t, "invite-burned", "KKKKKKKKKKKKKKKK")
	if err := echo(f.ctx, psec, "p"); err != nil {
		t.Fatal(err)
	}
	f.h.setList(t, 2) // drops k
	if code := closedWith(f.ctx, csec); code != wire.CodeNotAdmitted {
		t.Fatalf("the client session closed %d, want 4401", code)
	}
	if err := echo(f.ctx, psec, "still"); err != nil {
		t.Fatalf("the pairing session of the same key closed on a list change: %v", err)
	}
	f.h.c.Close()
	if code := closedWith(f.ctx, psec); code != wire.CodeNotAdmitted {
		t.Fatalf("the pairing session of an ended registration closed %d, want 4401", code)
	}
}
