package daemon

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// hookedFounder starts a founder whose options set adjusts.
func hookedFounder(t *testing.T, ctx context.Context, rs *relaytest.Server, set func(*Options)) *node {
	t.Helper()
	st := shortDir(t)
	id := identity(t, st, rs.URL, "a")
	if _, err := mesh.Found(st, id, "a", 1); err != nil {
		t.Fatal(err)
	}
	return startWith(t, ctx, rs, st, set)
}

// gate is a test hook that stops its caller while armed.
type hookGate struct {
	armed   atomic.Bool
	reached chan struct{}
	release chan struct{}
}

func newHookGate() *hookGate {
	return &hookGate{reached: make(chan struct{}, 4), release: make(chan struct{})}
}

func (g *hookGate) hook() {
	if g.armed.CompareAndSwap(true, false) {
		g.reached <- struct{}{}
		<-g.release
	}
}

func TestAReplacementClosesTheOldSessionsWhileTheOldHolderCannotBeWrittenTo(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	g := newHookGate()
	a := hookedFounder(t, ctx, rs, func(o *Options) { o.HolderWriting = g.hook })
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
	g.armed.Store(true)
	old.c.Write([]byte(cancelOp("AAAAAAAAAAAAAAAA") + "\n"))
	<-g.reached // the old holder's writer holds write ownership and is stuck: replaced cannot be written
	register(t, a, "goat", prog.port(), key)
	if code := closedWith(ctx, sec); code != wire.CodeNotAdmitted {
		t.Fatalf("the old registration's client session closed %d, want 4401 while its holder notice is blocked", code)
	}
	close(g.release)
}

func TestTheEndOfAReplacedRegistrationWaitsForItsMemberDeliveriesToClose(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	g := newHookGate()
	ended := make(chan string, 8)
	a := hookedFounder(t, ctx, rs, func(o *Options) {
		o.RegistrationEnding = g.hook
		o.ServiceEnded = func(id string) { ended <- id }
	})
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	key := newKey(t)
	prog := newProgram(t, "goat", key)
	prog.serve()
	old := register(t, a, "goat", prog.port(), key)
	sec, err := openService(t, ctx, []string{rs.URL}, b, memberNamed(t, b, "a"), "goat")
	if err != nil {
		t.Fatal(err)
	}
	if err := echo(ctx, sec, "m"); err != nil {
		t.Fatal(err)
	}
	<-prog.identities
	g.armed.Store(true)
	register(t, a, "goat", prog.port(), key)
	<-g.reached // the old registration's teardown has started and holds before closing the member delivery
	if m, ok := old.next(t); !ok || m["t"] != "replaced" {
		t.Fatalf("old holder got %v, %v; want replaced while the teardown is held", m, ok)
	}
	if _, ok := old.next(t); ok {
		t.Fatal("old holder stayed open")
	}
	ended <- "released"
	close(g.release)
	if e := <-ended; e != "released" {
		t.Fatalf("the old registration ended (%s) before its member delivery was closed", e)
	}
	if e := <-ended; e != old.reply["id"] {
		t.Fatalf("ended %q, want %v", e, old.reply["id"])
	}
	closedWith(ctx, sec)
}

func TestAListDropFinishesClosingTheSessionAndItsDeliveryBeforeItsAnswer(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	events := make(chan string, 8)
	a := hookedFounder(t, ctx, rs, func(o *Options) { o.ClientClosed = func() { events <- "closed" } })
	key := newKey(t)
	prog := newProgram(t, "goat", key)
	prog.serve()
	h := register(t, a, "goat", prog.port(), key)
	p := phone(t)
	h.setList(t, 1, p)
	sec, err := dialAs(ctx, rs, p, a, goatService())
	if err != nil {
		t.Fatal(err)
	}
	if err := echo(ctx, sec, "x"); err != nil {
		t.Fatal(err)
	}
	h.setList(t, 2)
	events <- "answer"
	if first := <-events; first != "closed" {
		t.Fatalf("the list answer came before the session and its delivery were closed (%s first)", first)
	}
}

func relayCode(err error) uint16 { return relay.CodeOf(err) }
