package relay_test

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

type upEvents chan bool

func startUplink(t *testing.T, ctx context.Context, rs *relaytest.Server, id *ident.Identity) (*relay.Uplink, upEvents, chan error) {
	t.Helper()
	u := relay.NewUplink(rs.URL, id)
	u.MinBackoff = time.Millisecond
	ev := make(upEvents, 16)
	u.OnState = func(up bool) { ev <- up }
	done := make(chan error, 1)
	go func() { done <- u.Run(ctx) }()
	if !<-ev {
		t.Fatal("uplink did not come up")
	}
	if err := rs.WaitOnline(ctx, id.NodeID()); err != nil {
		t.Fatal(err)
	}
	return u, ev, done
}

func newID(t *testing.T) *ident.Identity {
	id, err := ident.Generate(nil)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestClientSessionCarriesMessagesAndCloseCodesBothWays(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	id := newID(t)
	u, _, _ := startUplink(t, ctx, rs, id)

	c, err := relay.Dial(ctx, rs.URL, id.NodeID())
	if err != nil {
		t.Fatal(err)
	}
	n, err := u.Accept(ctx)
	if err != nil {
		t.Fatal(err)
	}
	big := bytes.Repeat([]byte{7}, 300<<10)
	for i := 0; i < 4; i++ {
		if err := c.Send(big); err != nil {
			t.Fatal(err)
		}
		got, err := n.Recv(ctx)
		if err != nil || !bytes.Equal(got, big) {
			t.Fatalf("node recv %d: %v", i, err)
		}
		if err := n.Send(big); err != nil {
			t.Fatal(err)
		}
		got, err = c.Recv(ctx)
		if err != nil || !bytes.Equal(got, big) {
			t.Fatalf("client recv %d: %v", i, err)
		}
	}
	if err := n.Close(wire.CodeNotAdmitted); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Recv(ctx); relay.CodeOf(err) != wire.CodeNotAdmitted {
		t.Fatalf("client saw %v, want 4401", err)
	}

	c2, err := relay.Dial(ctx, rs.URL, id.NodeID())
	if err != nil {
		t.Fatal(err)
	}
	n2, _ := u.Accept(ctx)
	c2.Close(wire.CodeTimeout)
	if _, err := n2.Recv(ctx); relay.CodeOf(err) != wire.CodeTimeout {
		t.Fatalf("node saw %v, want 4408", err)
	}
	if got := rs.BadAcks.Load(); got != 0 {
		t.Fatalf("relay rejected %d acks", got)
	}
}

func TestClientToOfflineNodeCloses4404(t *testing.T) {
	ctx := context.Background()
	rs := relaytest.New()
	defer rs.Close()
	c, err := relay.Dial(ctx, rs.URL, newID(t).NodeID())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Recv(ctx); relay.CodeOf(err) != wire.CodeOffline {
		t.Fatalf("got %v, want 4404", err)
	}
}

func TestNewerUplinkReplacesOlderAndOlderStops(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	id := newID(t)
	_, _, done1 := startUplink(t, ctx, rs, id)
	startUplink(t, ctx, rs, id)
	if err := <-done1; !errors.Is(err, relay.ErrReplaced) {
		t.Fatalf("older uplink ended with %v, want ErrReplaced", err)
	}
}

func TestDroppedUplinkReconnectsAndEndsItsSessions(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	id := newID(t)
	u, ev, _ := startUplink(t, ctx, rs, id)
	c, err := relay.Dial(ctx, rs.URL, id.NodeID())
	if err != nil {
		t.Fatal(err)
	}
	n, _ := u.Accept(ctx)
	rs.DropUplink(id.NodeID())
	if up := <-ev; up {
		t.Fatal("expected down")
	}
	if _, err := n.Recv(ctx); relay.CodeOf(err) != wire.CodeOffline {
		t.Fatalf("node session saw %v, want 4404", err)
	}
	if _, err := c.Recv(ctx); relay.CodeOf(err) != wire.CodeOffline {
		t.Fatalf("client saw %v, want 4404", err)
	}
	if up := <-ev; !up {
		t.Fatal("expected the uplink back")
	}
	if err := rs.WaitOnline(ctx, id.NodeID()); err != nil {
		t.Fatal(err)
	}
}

