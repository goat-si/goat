package daemon

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/session"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

func TestAListDropWaitsForADroppedKeysHandshakeThatConfirmedButIsNotRegisteredYet(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	g := newHookGate()
	defer g.open()
	events := make(chan string, 64)
	waiting := make(chan int, 4)
	var answering atomic.Bool
	a := hookedFounder(t, ctx, rs, func(o *Options) {
		o.ClientConfirmed = g.hook
		o.ClientsWaiting = func(n int) { waiting <- n }
		o.PhoneSlots = func(total int) { events <- fmt.Sprint("slots:", total) }
		// Reported as the answer becomes ready to write, on the daemon's goroutine that made it ready, in order with
		// the events above: the list answer is the only holder line once armed.
		o.HolderFilling = func() {
			if answering.Load() {
				events <- "answer"
			}
		}
	})
	key := newKey(t)
	prog := newProgram(t, "goat", key)
	prog.serve()
	h := register(t, a, "goat", prog.port(), key)
	k := phone(t)
	h.setList(t, 1, k)
	<-waiting // the first list dropped nothing
	p := unconfirmed(t, ctx, rs, a, k, session.KindSession, nil, goatService())
	g.armed.Store(true)
	sec, err := p.Confirm()
	if err != nil {
		t.Fatal(err)
	}
	<-g.reached // confirmed on the node, not yet registered as a session
	answering.Store(true)
	if _, err := h.c.Write([]byte(listOp(2) + "\n")); err != nil {
		t.Fatal(err)
	}
	answered := make(chan error, 1)
	go func() {
		_, err := h.r.ReadBytes('\n')
		answered <- err
	}()
	if n := <-waiting; n != 1 {
		t.Fatalf("the list drop waits for %d handshakes; want the dropped key's confirmed one", n)
	}
	g.open()
	if err := <-answered; err != nil {
		t.Fatal(err)
	}
	if got := slotsBefore(t, events, "answer"); got != "slots:0" {
		t.Fatalf("the list answer was ready with %q; want the handshake closed and its slot returned first", got)
	}
	if code := closedWith(ctx, sec); code != wire.CodeNotAdmitted {
		t.Fatalf("closed %d, want 4401", code)
	}
}

func TestAListDropDuringADeliveryAnswersBeforeThatDeliveryEnds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	events := make(chan string, 64)
	var answering atomic.Bool
	a := hookedFounder(t, ctx, rs, func(o *Options) {
		o.ClientEnded = func() { events <- "session goroutine ended" }
		// Reported as the answer becomes ready to write, on the daemon's goroutine that made it ready, in order with
		// the events above: the list answer is the only holder line once armed.
		o.HolderFilling = func() {
			if answering.Load() {
				events <- "answer"
			}
		}
	})
	key := newKey(t)
	prog := newProgram(t, "goat", key)
	prog.reached, prog.hold = make(chan struct{}, 1), make(chan struct{})
	prog.serve()
	defer close(prog.hold)
	h := register(t, a, "goat", prog.port(), key)
	k := phone(t)
	h.setList(t, 1, k)
	sec, err := dialAs(ctx, rs, k, a, goatService())
	if err != nil {
		t.Fatal(err)
	}
	<-prog.reached // the session is registered and its delivery waits for the program's proof
	answering.Store(true)
	h.setList(t, 2)
	if first := <-events; first != "answer" {
		t.Fatalf("%s before the list answer; want the drop to answer once the session is closed, without waiting for its delivery", first)
	}
	if code := closedWith(ctx, sec); code != wire.CodeNotAdmitted {
		t.Fatalf("closed %d, want 4401", code)
	}
}
