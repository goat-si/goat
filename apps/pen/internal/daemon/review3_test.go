package daemon

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/session"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// orderedNode reports phone slot counts and registration ends, in order, on one channel.
func orderedNode(t *testing.T) (context.Context, *relaytest.Server, *node, chan string) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	rs := relaytest.New()
	t.Cleanup(rs.Close)
	events := make(chan string, 64)
	a := hookedFounder(t, ctx, rs, func(o *Options) {
		o.PhoneSlots = func(total int) { events <- fmt.Sprint("slots:", total) }
		o.ServiceEnded = func(id string) { events <- "ended:" + id }
	})
	return ctx, rs, a, events
}

// unconfirmed sends message 1 for id with kind and payload and returns once message 2 verified, without confirming.
func unconfirmed(t *testing.T, ctx context.Context, rs *relaytest.Server, a *node, id *ident.Identity, kind byte, psk []byte, p session.Payload) *session.Pending {
	t.Helper()
	conn, err := relay.Dial(ctx, rs.URL, a.d.NodeID())
	if err != nil {
		t.Fatal(err)
	}
	pending, err := session.InitiateHandshake(ctx, conn, kind, a.d.NodeID(), a.id.NoisePub, id, psk, p)
	if err != nil {
		t.Fatal(err)
	}
	return pending
}

// slotsBefore reads events until stop and returns the last slot count seen before it.
func slotsBefore(t *testing.T, events chan string, stop string) string {
	t.Helper()
	last := ""
	for e := range events {
		if e == stop {
			return last
		}
		if len(e) > 6 && e[:6] == "slots:" {
			last = e
		}
	}
	return last
}

// refusedAtConfirmation confirms p and requires the node to have closed it 4401.
func refusedAtConfirmation(t *testing.T, ctx context.Context, p *session.Pending) {
	t.Helper()
	sec, err := p.Confirm()
	if err != nil {
		if relay.CodeOf(err) != wire.CodeNotAdmitted {
			t.Fatalf("confirmation got %v, want the node's 4401", err)
		}
		return
	}
	if code := closedWith(ctx, sec); code != wire.CodeNotAdmitted {
		t.Fatalf("closed %d, want 4401", code)
	}
}

func setupUnconfirmed(t *testing.T) (context.Context, *node, chan string, *holder, *session.Pending, *session.Pending, *program) {
	t.Helper()
	ctx, rs, a, events := orderedNode(t)
	key := newKey(t)
	prog := newProgram(t, "goat", key)
	prog.serve()
	h := register(t, a, "goat", prog.port(), key)
	k := phone(t)
	h.setList(t, 1, k)
	client := unconfirmed(t, ctx, rs, a, k, session.KindSession, nil, goatService())
	psk := newKey(t)
	if m := h.op(t, inviteOp("UUUUUUUUUUUUUUUU", ident.B64.EncodeToString(psk), a.d.now().UnixMilli()+60_000)); m["t"] != "invite" {
		t.Fatalf("invite answered %v", m)
	}
	pairing := unconfirmed(t, ctx, rs, a, phone(t), session.KindJoin, psk, servicePair("UUUUUUUUUUUUUUUU"))
	return ctx, a, events, h, client, pairing, prog
}

func TestTheEndOfARegistrationClosesItsUnconfirmedHandshakesAndReturnsTheirSlotsFirst(t *testing.T) {
	ctx, _, events, h, client, pairing, _ := setupUnconfirmed(t)
	id := h.reply["id"].(string)
	h.c.Close()
	if got := slotsBefore(t, events, "ended:"+id); got != "slots:0" {
		t.Fatalf("the registration ended with %q; want its unconfirmed handshakes closed and their slots returned first", got)
	}
	refusedAtConfirmation(t, ctx, client)
	refusedAtConfirmation(t, ctx, pairing)
}

func TestAReplacementClosesTheOldUnconfirmedHandshakesBeforeTheOldRegistrationEnds(t *testing.T) {
	ctx, a, events, h, client, pairing, prog := setupUnconfirmed(t)
	id := h.reply["id"].(string)
	register(t, a, "goat", prog.port(), prog.key)
	if got := slotsBefore(t, events, "ended:"+id); got != "slots:0" {
		t.Fatalf("the replaced registration ended with %q; want its unconfirmed handshakes closed first", got)
	}
	refusedAtConfirmation(t, ctx, client)
	refusedAtConfirmation(t, ctx, pairing)
}

func TestAListDropClosesTheDroppedKeysUnconfirmedHandshakesBeforeItsAnswer(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	events := make(chan string, 64)
	waiting := make(chan int, 4)
	var answering atomic.Bool
	a := hookedFounder(t, ctx, rs, func(o *Options) {
		o.PhoneSlots = func(total int) { events <- fmt.Sprint("slots:", total) }
		o.ClientsWaiting = func(n int) { waiting <- n }
		// Reported on the daemon's writer as it starts the write: the list answer is the only holder line once armed.
		o.HolderWriting = func() {
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
	answering.Store(true)
	h.setList(t, 2)
	if n := <-waiting; n != 1 {
		t.Fatalf("the list drop waits for %d handshakes; want the dropped key's unconfirmed one", n)
	}
	if got := slotsBefore(t, events, "answer"); got != "slots:0" {
		t.Fatalf("the list answer was written with %q; want the dropped key's unconfirmed handshake closed first", got)
	}
	refusedAtConfirmation(t, ctx, p)
}
