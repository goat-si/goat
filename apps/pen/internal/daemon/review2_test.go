package daemon

import (
	"context"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
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
	once    sync.Once
	armed   atomic.Bool
	reached chan struct{}
	release chan struct{}
}

// newHookGate makes a gate. A test defers open, so a failed assertion never strands the daemon shutdown: defers run
// before the cleanup that stops the daemon.
func newHookGate() *hookGate {
	return &hookGate{reached: make(chan struct{}, 4), release: make(chan struct{})}
}

func (g *hookGate) open() { g.once.Do(func() { close(g.release) }) }

func (g *hookGate) hook() {
	if g.armed.CompareAndSwap(true, false) {
		g.reached <- struct{}{}
		<-g.release
	}
}

func awaitSignal(t *testing.T, ctx context.Context, signal <-chan struct{}, message string) {
	t.Helper()
	waitCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	select {
	case <-signal:
	case <-waitCtx.Done():
		t.Fatalf("%s: %v", message, waitCtx.Err())
	}
}

func TestAReplacementClosesTheOldSessionsWhileTheOldHolderCannotBeWrittenTo(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	g := newHookGate()
	defer g.open()
	closed := make(chan struct{}, 4)
	a := hookedFounder(t, ctx, rs, func(o *Options) {
		o.HolderWriting = g.hook
		o.ClientClosed = func() { closed <- struct{}{} }
	})
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
	// The old holder's writer holds write ownership and is stuck: replaced cannot be written.
	awaitSignal(t, ctx, g.reached, "the old holder's writer never reached its write hook")
	register(t, a, "goat", prog.port(), key)
	awaitSignal(t, ctx, closed, "the old registration's client session was not closed")
	if code := closedWith(ctx, sec); code != wire.CodeNotAdmitted {
		t.Fatalf("the old registration's client session closed %d, want 4401 while its holder notice is blocked", code)
	}
	g.open()
}

func TestTheEndOfAReplacedRegistrationWaitsForItsMemberDeliveriesToClose(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	g := newHookGate()
	defer g.open()
	ended := make(chan string, 8)
	joins := make(chan string, 8)
	a := hookedFounder(t, ctx, rs, func(o *Options) {
		o.RegistrationEnding = g.hook
		o.RegistrationJoining = func(id string) { joins <- id }
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
	// The other caller (the old holder's own cleanup, or the replacement if the cleanup took the teardown) is at its
	// wait for the held teardown: the old registration cannot have ended.
	for <-joins != old.reply["id"] {
	}
	select {
	case e := <-ended:
		t.Fatalf("the old registration ended (%s) while its teardown was still held", e)
	default:
	}
	g.open()
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
	var answering atomic.Bool
	a := hookedFounder(t, ctx, rs, func(o *Options) {
		o.ClientClosed = func() { events <- "closed" }
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
	p := phone(t)
	h.setList(t, 1, p)
	sec, err := dialAs(ctx, rs, p, a, goatService())
	if err != nil {
		t.Fatal(err)
	}
	if err := echo(ctx, sec, "x"); err != nil {
		t.Fatal(err)
	}
	answering.Store(true)
	h.setList(t, 2)
	if first := <-events; first != "closed" {
		t.Fatalf("the list answer was ready before the session and its delivery were closed (%s first)", first)
	}
}

func relayCode(err error) uint16 { return relay.CodeOf(err) }

func TestAReplacementClosesTheOldSessionsBeforeTheNewHolderIsAnswered(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	g := newHookGate()
	defer g.open()
	closed := make(chan struct{}, 4)
	a := hookedFounder(t, ctx, rs, func(o *Options) {
		o.Registering = g.hook
		o.ClientClosed = func() { closed <- struct{}{} }
	})
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
	c, err := net.Dial("unix", SocketPath(a.st))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Write([]byte(`{"op":"service.register","name":"goat","port":` + strconv.Itoa(prog.port()) +
		`,"key":"` + ident.B64.EncodeToString(key) + `"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	// The new registration is current and its holder has not been answered.
	awaitSignal(t, ctx, g.reached, "the new registration never reached its registering hook")
	awaitSignal(t, ctx, closed, "the old registration's client session was not closed before the new holder is answered")
	if code := closedWith(ctx, sec); code != wire.CodeNotAdmitted {
		t.Fatalf("the old client session closed %d, want 4401 before the new holder is answered", code)
	}
	g.open()
}
