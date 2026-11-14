package daemon

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"reflect"
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
	// ended receives the id of each registration once its end closed everything it admitted.
	ended chan string
}

func newPairFixture(t *testing.T) *pairFixture {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	rs := relaytest.New()
	t.Cleanup(rs.Close)
	clk := &clock{}
	clk.ms.Store(time.Now().UnixMilli())
	ended := make(chan string, 16) // a fixture registers at most twice; the daemon's stop ends the rest
	a := hookedFounder(t, ctx, rs, func(o *Options) {
		o.Now = clk.now
		o.ServiceEnded = func(id string) { ended <- id }
	})
	key := newKey(t)
	prog := newProgram(t, "goat", key)
	prog.serve()
	return &pairFixture{ctx: ctx, rs: rs, a: a, clk: clk, prog: prog, h: register(t, a, "goat", prog.port(), key), ended: ended}
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
	var who []*ident.Identity
	for i := range 4 {
		k := phone(t)
		p, err := f.pair(t, k, psk, servicePair(id))
		if err != nil {
			t.Fatalf("handshake %d: %v, want message 2", i+1, err)
		}
		ps = append(ps, p)
		who = append(who, k)
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
	// The whole line, member by member: the pairing form names the invite, the winner's key and its handshake's sas.
	var j map[string]any
	if err := json.Unmarshal(<-f.prog.identities, &j); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"v": float64(1), "mesh": f.a.d.view().MeshID, "self": f.a.d.NodeID(), "stream": "goat",
		"pairing": map[string]any{
			"invite":   id,
			"noisePub": noiseText(who[2]),
			"sas":      ident.B64.EncodeToString(session.PairSAS(sec.HandshakeHash)),
		},
	}
	if !reflect.DeepEqual(j, want) {
		t.Fatalf("pairing line %v; want exactly %v", j, want)
	}
	refusedAtConfirmation(t, f.ctx, ps[0]) // one burn: a second confirmation gets 4401
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

func TestCancellingAnInviteThatBurnedAndThenExpiredReportsBurned(t *testing.T) {
	f := newPairFixture(t)
	const id = "DDDDDDDDDDDDDDDD"
	psk := f.invite(t, id)
	p, err := f.pair(t, phone(t), psk, servicePair(id))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Confirm(); err != nil {
		t.Fatal(err)
	}
	f.event(t, "invite-burned", id)
	f.clk.advance(6 * time.Minute)
	if m := f.h.op(t, cancelOp(id)); m["t"] != "invite-cancelled" || m["was"] != "burned" {
		t.Fatalf("cancel answered %v; want burned, which takes precedence over expiry", m)
	}
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

func TestAMeshInviteAndAServiceInviteWithTheSameIDEachAcceptOnlyTheirOwnPSK(t *testing.T) {
	f := newPairFixture(t)
	tok := f.a.invite(t, time.Minute)
	id := session.InviteID(tok.Secret)
	meshPSK, _ := session.JoinPSK(tok.Secret, f.a.d.NodeID(), f.a.id.NoisePub)
	svcPSK := f.invite(t, id) // the service invite takes the mesh invite's id, with its own psk
	join := session.Payload{V: 1, Stream: "join", Invite: id, Name: "x"}
	if _, err := f.pair(t, phone(t), meshPSK, servicePair(id)); !errors.Is(err, session.ErrBadMessage2) {
		t.Fatalf("service-pair with the mesh psk got %v, want a message 2 that does not verify", err)
	}
	if _, err := f.pair(t, phone(t), svcPSK, join); !errors.Is(err, session.ErrBadMessage2) {
		t.Fatalf("join with the service psk got %v, want a message 2 that does not verify", err)
	}
	p, err := f.pair(t, phone(t), svcPSK, servicePair(id))
	if err != nil {
		t.Fatalf("service-pair with its own psk got %v, want message 2", err)
	}
	p.Abort(wire.CodeNormal)
	q, err := f.pair(t, phone(t), meshPSK, join)
	if err != nil {
		t.Fatalf("join with its own psk got %v, want message 2", err)
	}
	q.Abort(wire.CodeNormal)
}

func TestAReplacedRegistrationsInviteAnswersNoNewHandshake(t *testing.T) {
	f := newPairFixture(t)
	const id = "RRRRRRRRRRRRRRRR"
	psk := f.invite(t, id)
	register(t, f.a, "goat", f.prog.port(), f.prog.key)
	if _, err := f.pair(t, phone(t), psk, servicePair(id)); relay.CodeOf(err) != wire.CodeNotAdmitted {
		t.Fatalf("the replaced registration's invite got %v, want 4401 with no message 2", err)
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
	// closedWith's FIN would end the session normally (1000) if it reached the program before the end did.
	waitCtx, cancel := context.WithTimeout(f.ctx, 30*time.Second)
	defer cancel()
	select {
	case id := <-f.ended:
		if id != f.h.reply["id"] {
			t.Fatalf("registration %s ended, want %v", id, f.h.reply["id"])
		}
	case <-waitCtx.Done():
		t.Fatalf("registration %v did not end: %v", f.h.reply["id"], waitCtx.Err())
	}
	if code := closedWith(f.ctx, psec); code != wire.CodeNotAdmitted {
		t.Fatalf("the pairing session of an ended registration closed %d, want 4401", code)
	}
}
