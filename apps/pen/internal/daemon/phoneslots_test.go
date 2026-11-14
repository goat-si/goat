package daemon

import (
	"context"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/session"
	"github.com/goat-si/goat/apps/pen/internal/state"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// slotNode runs a founder on two relays whose PhoneSlots hook reports every count, with a goat registration.
type slotNode struct {
	ctx    context.Context
	a, b   *relaytest.Server
	n      *node
	counts chan int
	h      *holder
	prog   *program
}

func newSlotNode(t *testing.T, progKey []byte) *slotNode {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	ra, rb := relaytest.New(), relaytest.New()
	t.Cleanup(ra.Close)
	t.Cleanup(rb.Close)
	st := shortDir(t)
	id := identity(t, st, ra.URL, "a")
	if err := st.SaveConfig(state.Config{Relay: ra.URL, Relays: []string{ra.URL, rb.URL}, Name: "a"}); err != nil {
		t.Fatal(err)
	}
	if _, err := mesh.Found(st, id, "a", 1); err != nil {
		t.Fatal(err)
	}
	counts := make(chan int, 256)
	n := startWith(t, ctx, ra, st, func(o *Options) { o.PhoneSlots = func(total int) { counts <- total } })
	if err := rb.WaitOnline(ctx, n.d.NodeID()); err != nil {
		t.Fatal(err)
	}
	key := newKey(t)
	if progKey == nil {
		progKey = key
	}
	prog := newProgram(t, "goat", progKey)
	prog.serve()
	return &slotNode{ctx: ctx, a: ra, b: rb, n: n, counts: counts, h: register(t, n, "goat", prog.port(), key), prog: prog}
}

// pending sends message 1 for id on relay rs and returns the handshake once message 2 verified.
func (s *slotNode) pending(t *testing.T, rs *relaytest.Server, id *ident.Identity) (*session.Pending, error) {
	t.Helper()
	conn, err := relay.Dial(s.ctx, rs.URL, s.n.d.NodeID())
	if err != nil {
		t.Fatal(err)
	}
	return session.InitiateHandshake(s.ctx, conn, session.KindSession, s.n.d.NodeID(), s.n.id.NoisePub, id, nil, goatService())
}

// total waits, bounded, until the node reports n held slots.
func (s *slotNode) total(t *testing.T, n int) {
	t.Helper()
	timeout := time.NewTimer(30 * time.Second)
	defer timeout.Stop()
	for {
		select {
		case got := <-s.counts:
			if got == n {
				return
			}
		case <-timeout.C:
			t.Fatalf("the node never reported %d held phone slots", n)
		}
	}
}

func TestPhoneSlotCapsRefuseTheNinthOnARelayTheThirteenthOnTheNodeAndTheFifthPerKeyBeforeMessage2(t *testing.T) {
	s := newSlotNode(t, nil)
	k1, k2, k3, k4 := phone(t), phone(t), phone(t), phone(t)
	s.h.setList(t, 1, k1, k2, k3, k4)
	var held []*session.Pending
	defer func() {
		for _, p := range held {
			p.Abort(wire.CodeNormal)
		}
	}()
	answered := func(why string, rs *relaytest.Server, id *ident.Identity) {
		t.Helper()
		p, err := s.pending(t, rs, id)
		if err != nil {
			t.Fatalf("%s: %v, want message 2", why, err)
		}
		held = append(held, p)
	}
	refused := func(why string, rs *relaytest.Server, id *ident.Identity) {
		t.Helper()
		if p, err := s.pending(t, rs, id); relay.CodeOf(err) != wire.CodeNotAdmitted {
			if p != nil {
				held = append(held, p)
			}
			t.Fatalf("%s: got %v, want 4401 with no message 2", why, err)
		}
	}
	for range 4 {
		answered("k1 on relay a", s.a, k1)
	}
	refused("a fifth slot for k1 (on the other relay)", s.b, k1)
	for range 4 {
		answered("k2 on relay a", s.a, k2)
	}
	refused("a ninth slot on relay a", s.a, k3)
	for range 4 {
		answered("k3 on relay b", s.b, k3)
	}
	refused("a thirteenth slot on the node", s.b, k4)
}

func TestAPhoneSlotIsReturnedHoweverItsSessionEnds(t *testing.T) {
	s := newSlotNode(t, nil)
	k := phone(t)
	s.h.setList(t, 1, k)

	p, err := s.pending(t, s.a, k)
	if err != nil {
		t.Fatal(err)
	}
	s.total(t, 1)
	p.Abort(wire.CodeNormal) // a handshake race loser closes 1000 unconfirmed
	s.total(t, 0)

	p, err = s.pending(t, s.a, k)
	if err != nil {
		t.Fatal(err)
	}
	s.total(t, 1)
	s.h.setList(t, 2) // dropped after message 2: refused at the check after confirmation
	refusedAtConfirmation(t, s.ctx, p)
	s.total(t, 0)

	s.h.setList(t, 3, k)
	sec, err := openMember(s.ctx, []string{s.a.URL}, k, s.n.d.NodeID(), s.n.id.NoisePub, goatService())
	if err != nil {
		t.Fatal(err)
	}
	if err := echo(s.ctx, sec, "x"); err != nil {
		t.Fatal(err)
	}
	s.total(t, 1)
	closedWith(s.ctx, sec) // a normal end
	s.total(t, 0)

	conn, err := relay.Dial(s.ctx, s.a.URL, s.n.d.NodeID()) // held: its close shows when relay a forgot the uplink
	if err != nil {
		t.Fatal(err)
	}
	if p, err = session.InitiateHandshake(s.ctx, conn, session.KindSession, s.n.d.NodeID(), s.n.id.NoisePub, k, nil, goatService()); err != nil {
		t.Fatal(err)
	}
	s.total(t, 1)
	if !s.a.DropUplink(s.n.d.NodeID()) { // the uplink that carried it is gone
		t.Fatal("the node has no uplink on relay a to drop")
	}
	s.total(t, 0)
	// Relay a counts a dropped uplink as online until it forgets it, and closes its clients 4404 only after that.
	waitCtx, cancel := context.WithTimeout(s.ctx, 30*time.Second)
	defer cancel()
	if _, err := conn.Recv(waitCtx); relay.CodeOf(err) != wire.CodeOffline {
		t.Fatalf("the handshake on the dropped uplink ended %v, want the relay's 4404", err)
	}
	if err := s.a.WaitOnline(waitCtx, s.n.d.NodeID()); err != nil {
		t.Fatalf("no uplink replaced the dropped one on relay a: %v", err)
	}
	if p, err = s.pending(t, s.a, k); err != nil {
		t.Fatalf("after the uplink came back: %v", err)
	}
	s.total(t, 1)
	p.Abort(wire.CodeNormal)
	s.total(t, 0)
}

func TestAPhoneSlotIsReturnedWhenTheDeliveryFails(t *testing.T) {
	s := newSlotNode(t, newKey(t)) // the program cannot prove the registered key
	k := phone(t)
	s.h.setList(t, 1, k)
	sec, err := openMember(s.ctx, []string{s.a.URL}, k, s.n.d.NodeID(), s.n.id.NoisePub, goatService())
	if err != nil {
		t.Fatal(err)
	}
	if code := closedWith(s.ctx, sec); code != wire.CodeOffline {
		t.Fatalf("a failed delivery closed %d, want 4404", code)
	}
	s.total(t, 1)
	s.total(t, 0)
}
