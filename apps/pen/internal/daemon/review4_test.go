package daemon

import (
	"context"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

func TestAHandshakeThatReachesItsDeadlineUnconfirmedReturnsItsSlot(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	deadlines := make(chan context.CancelFunc, 8)
	counts := make(chan int, 64)
	st := shortDir(t)
	id := identity(t, st, rs.URL, "a")
	if err := st.SaveConfig(state.Config{Relay: rs.URL, Name: "a"}); err != nil {
		t.Fatal(err)
	}
	if _, err := mesh.Found(st, id, "a", 1); err != nil {
		t.Fatal(err)
	}
	n := startWith(t, ctx, rs, st, func(o *Options) {
		o.PhoneSlots = func(total int) { counts <- total }
		// Each handshake's context ends when the test says: the path its 10 s deadline takes.
		o.HandshakeContext = func(parent context.Context) context.Context {
			hctx, end := context.WithCancel(parent)
			deadlines <- end
			return hctx
		}
	})
	key := newKey(t)
	prog := newProgram(t, "goat", key)
	prog.serve()
	h := register(t, n, "goat", prog.port(), key)
	k := phone(t)
	h.setList(t, 1, k)
	s := &slotNode{ctx: ctx, a: rs, n: n, counts: counts, h: h, prog: prog}
	if _, err := s.pending(t, rs, k); err != nil {
		t.Fatal(err)
	}
	s.total(t, 1)
	(<-deadlines)() // the unconfirmed handshake reaches its deadline
	s.total(t, 0)
	p, err := s.pending(t, rs, k)
	if err != nil {
		t.Fatalf("a handshake after the deadline returned the slot: %v", err)
	}
	s.total(t, 1)
	p.Abort(1000)
}
