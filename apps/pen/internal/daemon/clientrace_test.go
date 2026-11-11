package daemon

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// heldCloses starts a node whose client close owners stop at ClientClosing while hold is set; held receives a value
// each time one stops there.
type heldCloses struct {
	hold    atomic.Bool
	held    chan struct{}
	release chan struct{}
	ended   chan struct{}
}

func heldNode(t *testing.T, ctx context.Context, rs *relaytest.Server, ended chan string) (*node, *heldCloses) {
	t.Helper()
	h := &heldCloses{held: make(chan struct{}, 4), release: make(chan struct{}), ended: make(chan struct{}, 16)}
	st := shortDir(t)
	id := identity(t, st, rs.URL, "a")
	if _, err := mesh.Found(st, id, "a", 1); err != nil {
		t.Fatal(err)
	}
	n := startWith(t, ctx, rs, st, func(o *Options) {
		o.ClientClosing = func() {
			if h.hold.Load() {
				h.held <- struct{}{}
				<-h.release
			}
		}
		if ended != nil {
			o.ServiceEnded = func(id string) { ended <- id }
		}
		o.ClientEnded = func() { h.ended <- struct{}{} }
	})
	return n, h
}

func TestADeliveryThatFailsWhileAListDropIsClosingItKeepsTheDropsCode(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a, held := heldNode(t, ctx, rs, nil)
	key := newKey(t)
	prog := newProgram(t, "goat", newKey(t)) // its answer cannot prove key: the delivery fails at line 2
	prog.reached, prog.hold = make(chan struct{}, 1), make(chan struct{})
	prog.serve()
	h := register(t, a, "goat", prog.port(), key)
	p := phone(t)
	h.setList(t, 1, p)
	sec, err := dialAs(ctx, rs, p, a, goatService())
	if err != nil {
		t.Fatal(err)
	}
	<-prog.reached
	held.hold.Store(true)
	answered := make(chan map[string]any, 1)
	go func() {
		h.c.Write([]byte(listOp(2) + "\n"))
		m, _ := h.next(t)
		answered <- m
	}()
	<-held.held // the list's teardown owns the close and has not closed yet
	close(prog.hold)
	<-prog.raw   // the delivery failed its proof while the teardown held the close
	<-held.ended // and its session's goroutine has finished every close it would make
	held.hold.Store(false)
	close(held.release)
	if m := <-answered; m["t"] != "clients" {
		t.Fatalf("list answered %v", m)
	}
	if code := closedWith(ctx, sec); code != wire.CodeNotAdmitted {
		t.Fatalf("closed %d, want the drop's 4401 (one close per session)", code)
	}
}

func TestReplacingARegistrationWhileItsListDropIsClosingTellsTheOldHolderAtOnceAndEndsItOnlyAfterThatClose(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	ended := make(chan string, 8)
	a, held := heldNode(t, ctx, rs, ended)
	key := newKey(t)
	prog := newProgram(t, "goat", key)
	prog.serve()
	old := register(t, a, "goat", prog.port(), key)
	p := phone(t)
	old.setList(t, 1, p)
	sec, err := dialAs(ctx, rs, p, a, goatService())
	if err != nil {
		t.Fatal(err)
	}
	if err := echo(ctx, sec, "x"); err != nil {
		t.Fatal(err)
	}
	held.hold.Store(true)
	events := make(chan string, 4)
	old.c.Write([]byte(listOp(2) + "\n"))
	<-held.held
	go func() {
		for {
			m, ok := old.next(t)
			if !ok {
				events <- "eof"
				return
			}
			events <- m["t"].(string)
		}
	}()
	register(t, a, "goat", prog.port(), key) // replaces old while its teardown holds the close
	// The old holder learns at once, while the close is still held.
	if e := <-events; e != "replaced" {
		t.Fatalf("old holder got %q, want replaced", e)
	}
	if e := <-events; e != "eof" {
		t.Fatalf("old holder got %q, want its connection closed", e)
	}
	ended <- "released"
	held.hold.Store(false)
	close(held.release)
	if e := <-ended; e != "released" {
		t.Fatalf("the old registration ended (%s) before its held close finished", e)
	}
	if e := <-ended; e != old.reply["id"] {
		t.Fatalf("ended %q, want the old registration %v", e, old.reply["id"])
	}
	if code := closedWith(ctx, sec); code != wire.CodeNotAdmitted {
		t.Fatalf("closed %d, want 4401", code)
	}
}

func TestListSwapsRacingClientSessionsNeverLeaveADroppedKeysSessionPastTheAnswer(t *testing.T) {
	f := newClientFixture(t)
	p, q := phone(t), phone(t)
	f.h.setList(t, 1, p, q)
	var wg sync.WaitGroup
	for _, k := range []*ident.Identity{p, q, p, q} {
		wg.Go(func() {
			for range 6 {
				sec, err := dialAs(f.ctx, f.rs, k, f.a, goatService())
				if err != nil {
					continue
				}
				echo(f.ctx, sec, "x")
				sec.Close(wire.CodeNormal)
			}
		})
	}
	for gen := 2; gen < 30; gen++ {
		keys := []*ident.Identity{q}
		if gen%2 == 0 {
			keys = append(keys, p)
		}
		f.h.setList(t, gen, keys...)
		if gen%2 == 1 {
			f.a.d.mu.Lock()
			for _, l := range f.a.d.sessions {
				if l.remote == noiseText(p) {
					f.a.d.mu.Unlock()
					t.Fatalf("gen %d dropped p, but a session of p is live after the answer", gen)
				}
			}
			f.a.d.mu.Unlock()
		}
	}
	wg.Wait()
	_ = relay.CodeOf
}
