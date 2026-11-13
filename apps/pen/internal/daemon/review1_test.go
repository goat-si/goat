package daemon

import (
	"context"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/session"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

func TestAPairingWhoseInviteExpiresWhileItWaitsForTheBurnCannotBurn(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	clk := &clock{}
	clk.ms.Store(time.Now().UnixMilli())
	var hold atomic.Bool
	reached, release := make(chan struct{}, 1), make(chan struct{})
	var once sync.Once
	open := func() { once.Do(func() { close(release) }) }
	defer open() // a failed assertion never leaves the hook holding the daemon's shutdown
	st := shortDir(t)
	id := identity(t, st, rs.URL, "a")
	if _, err := mesh.Found(st, id, "a", 1); err != nil {
		t.Fatal(err)
	}
	a := startWith(t, ctx, rs, st, func(o *Options) {
		o.Now = clk.now
		o.ClientRegistering = func() {
			if hold.Load() {
				reached <- struct{}{}
				<-release
			}
		}
	})
	key := newKey(t)
	prog := newProgram(t, "goat", key)
	prog.serve()
	f := &pairFixture{ctx: ctx, rs: rs, a: a, clk: clk, prog: prog, h: register(t, a, "goat", prog.port(), key)}
	psk := f.invite(t, "EEEEEEEEEEEEEEEE")
	p, err := f.pair(t, phone(t), psk, servicePair("EEEEEEEEEEEEEEEE"))
	if err != nil {
		t.Fatal(err)
	}
	hold.Store(true)
	sec, err := p.Confirm()
	if err != nil {
		t.Fatal(err)
	}
	<-reached // the burn's check has taken d.mu and waits here
	clk.advance(6 * time.Minute)
	hold.Store(false)
	open()
	if code := closedWith(ctx, sec); code != wire.CodeNotAdmitted {
		t.Fatalf("a pairing confirmed after its invite expired closed %d, want 4401", code)
	}
	if m := f.h.op(t, cancelOp("EEEEEEEEEEEEEEEE")); m["was"] != "absent" {
		t.Fatalf("cancel answered %v; the expired invite must not have burned", m)
	}
}

func TestTwoSimultaneousConfirmationsBurnTheInviteOnce(t *testing.T) {
	f := newPairFixture(t)
	id := "WWWWWWWWWWWWWWWW"
	psk := f.invite(t, id)
	var ps [2]*session.Pending
	for i := range ps {
		p, err := f.pair(t, phone(t), psk, servicePair(id))
		if err != nil {
			t.Fatal(err)
		}
		ps[i] = p
	}
	secs := make(chan *session.Secure, 2)
	start := make(chan struct{})
	for _, p := range ps {
		go func() {
			<-start
			sec, err := p.Confirm()
			if err != nil {
				secs <- nil
				return
			}
			secs <- sec
		}()
	}
	close(start)
	f.event(t, "invite-burned", id)
	open, refused := 0, 0
	for range 2 {
		sec := <-secs
		if sec == nil {
			t.Fatal("a confirmation could not be sent")
		}
		if err := echo(f.ctx, sec, "w"); err == nil {
			open++
		} else if code := closedWith(f.ctx, sec); code == wire.CodeNotAdmitted || relayCode(err) == wire.CodeNotAdmitted {
			refused++
		} else {
			t.Fatalf("the losing confirmation ended with %v, want 4401", err)
		}
	}
	if open != 1 || refused != 1 {
		t.Fatalf("%d sessions open and %d refused; want exactly one winner", open, refused)
	}
	// One burn only: the next holder line is the cancel's answer, which finds the invite burned.
	if m := f.h.op(t, cancelOp(id)); m["t"] != "invite-cancelled" || m["was"] != "burned" {
		t.Fatalf("after the race the holder read %v, want the cancel answer reporting burned", m)
	}
}

func TestAPhoneSlotStaysCountedUntilTheOwnerOfItsCloseFinishes(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a, held := heldNode(t, ctx, rs, nil)
	key := newKey(t)
	prog := newProgram(t, "goat", newKey(t)) // its proof fails: the session's own goroutine finishes early
	prog.reached, prog.hold = make(chan struct{}, 1), make(chan struct{})
	prog.serve()
	h := register(t, a, "goat", prog.port(), key)
	p := phone(t)
	h.setList(t, 1, p)
	if _, err := dialAs(ctx, rs, p, a, goatService()); err != nil {
		t.Fatal(err)
	}
	<-prog.reached
	held.hold.Store(true)
	go func() { h.c.Write([]byte(listOp(2) + "\n")) }()
	<-held.held // the list's teardown owns the close and has not closed
	close(prog.hold)
	<-held.ended // the goroutine that accepted the session has finished and released all it releases
	a.d.svc.mu.Lock()
	total := a.d.svc.phones.total
	a.d.svc.mu.Unlock()
	held.hold.Store(false)
	held.open()
	if total != 1 {
		t.Fatalf("%d phone slots held while the session's close is still pending; want 1", total)
	}
}

func TestStoppingTheDaemonDuringAHandshakeReturnsItsPhoneSlot(t *testing.T) {
	s := newSlotNode(t, nil)
	k := phone(t)
	s.h.setList(t, 1, k)
	if _, err := s.pending(t, s.a, k); err != nil {
		t.Fatal(err)
	}
	s.total(t, 1)
	s.n.d.Stop()
	s.total(t, 0)
}

func TestAListDropClosesTheProgramsConnectionForThatKey(t *testing.T) {
	f := newClientFixture(t)
	key := newKey(t)
	prog := newProgram(t, "goat", key)
	prog.finished = make(chan struct{}, 4)
	prog.serve()
	f.h = register(t, f.a, "goat", prog.port(), key)
	p := phone(t)
	f.h.setList(t, 1, p)
	sec, err := dialAs(f.ctx, f.rs, p, f.a, goatService())
	if err != nil {
		t.Fatal(err)
	}
	if err := echo(f.ctx, sec, "x"); err != nil {
		t.Fatal(err)
	}
	f.h.setList(t, 2)
	<-prog.finished // the node closed the program's connection; the program read EOF
	if code := closedWith(f.ctx, sec); code != wire.CodeNotAdmitted {
		t.Fatalf("closed %d, want 4401", code)
	}
}

func TestNoQueuedHolderLineIsWrittenAfterReplaced(t *testing.T) {
	near, far := net.Pipe()
	defer far.Close()
	q := newHolderQueue(near, nil) // a pipe cannot half-close, so nothing is drained
	reached, release := make(chan struct{}), make(chan struct{})
	q.whileWriting = func() {
		close(reached)
		<-release
	}
	go q.run()
	q.push([]byte("stale\n"))
	<-reached // the writer holds write ownership for a ready line and has not written
	got := make(chan string, 1)
	go func() {
		var b strings.Builder
		buf := make([]byte, 64)
		for {
			n, err := far.Read(buf)
			b.Write(buf[:n])
			if err != nil {
				got <- b.String()
				return
			}
		}
	}()
	go q.failWith([]byte("replaced\n"))
	<-q.dead // failWith marked the queue failed and waits for write ownership
	close(release)
	if s := <-got; s != "replaced\n" {
		t.Fatalf("the holder read %q, want only the replaced line", s)
	}
}
