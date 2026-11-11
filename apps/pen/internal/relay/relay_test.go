package relay_test

import (
	"bytes"
	"context"
	"errors"
	"net"
	"slices"
	"strings"
	"sync"
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

// answer opens a session the way the contract orders it: the client's first message (at most
// 4096 bytes; a relay may end a session that sends more before its node answers), then the node's.
func answer(t *testing.T, ctx context.Context, c, n relay.Conn) {
	t.Helper()
	if err := c.Send(make([]byte, 4096)); err != nil {
		t.Fatal(err)
	}
	if _, err := n.Recv(ctx); err != nil {
		t.Fatal(err)
	}
	if err := n.Send([]byte("answer")); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Recv(ctx); err != nil {
		t.Fatal(err)
	}
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
	answer(t, ctx, c, n)
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

func TestUnconfirmedLinkQueuesAtMostOneMiBThenCloses4408(t *testing.T) {
	chunk := make([]byte, 64<<10)
	a, b := relay.Pipe()
	var err error
	for sent := 0; err == nil && sent <= relay.PreHandshakeQueued; sent += len(chunk) {
		err = a.Send(chunk)
	}
	if relay.CodeOf(err) != wire.CodeTimeout {
		t.Fatalf("flooding an unconfirmed link: %v, want 4408", err)
	}
	if _, err := b.Recv(context.Background()); relay.CodeOf(err) != wire.CodeTimeout {
		t.Fatalf("receiver saw %v, want 4408", err)
	}

	a, b = relay.Pipe()
	b.(relay.QueueLimiter).SetQueueLimit(relay.MaxQueued)
	for sent := 0; sent < 4*relay.PreHandshakeQueued; sent += len(chunk) {
		if err := a.Send(chunk); err != nil {
			t.Fatalf("confirmed link refused %d queued bytes: %v", sent, err)
		}
	}
}

func TestUplinkAckCountsEveryRelayMessageIncludingTheChallenge(t *testing.T) {
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
	answer(t, ctx, c, n)
	if err := c.Send(make([]byte, 64<<10)); err != nil {
		t.Fatal(err)
	}
	got, err := rs.NextUplinkAck(ctx, id.NodeID())
	if err != nil {
		t.Fatal(err)
	}
	// challenge (32) + OPEN frame (5) + the first message's DATA frame (5 + 4096) + DATA frame (5 + 64 KiB)
	if want := uint64(32 + 5 + 5 + 4096 + 5 + 64<<10); got != want {
		t.Fatalf("first ack a:%d, want a:%d", got, want)
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
	// A send that loses the race with the relay's close reports the code the socket received.
	if err := c.Send([]byte("late")); relay.CodeOf(err) != wire.CodeOffline {
		t.Fatalf("send after the relay closed: %v, want 4404", err)
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

func dead(t *testing.T) string {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	url := "http://" + ln.Addr().String()
	ln.Close()
	return url
}

func TestDialRacePicksTheRelayThatAnswersAndSkipsADeadOne(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	id := newID(t)
	u, _, _ := startUplink(t, ctx, rs, id)
	c, used, err := relay.DialRace(ctx, []string{dead(t), rs.URL}, id.NodeID())
	if err != nil || used != rs.URL {
		t.Fatalf("used %q, %v; want the live relay", used, err)
	}
	n, _ := u.Accept(ctx)
	c.Send([]byte("x"))
	if p, err := n.Recv(ctx); err != nil || string(p) != "x" {
		t.Fatalf("node got %q, %v", p, err)
	}
}

func TestDialRaceIgnoresARelayWhereTheNodeIsOffline(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	offline, online := relaytest.New(), relaytest.New()
	defer offline.Close()
	defer online.Close()
	id := newID(t)
	startUplink(t, ctx, online, id)
	if _, used, err := relay.DialRace(ctx, []string{offline.URL, online.URL}, id.NodeID()); err != nil || used != online.URL {
		t.Fatalf("used %q, %v; want the relay that has the node", used, err)
	}
	if _, _, err := relay.DialRace(ctx, []string{offline.URL, dead(t)}, id.NodeID()); relay.CodeOf(err) != wire.CodeOffline {
		t.Fatalf("no relay has the node: %v, want 4404", err)
	}
}

func TestDialRaceClosesTheLosersWith1000BeforeAnyByte(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a, b := relaytest.New(), relaytest.New()
	defer a.Close()
	defer b.Close()
	id := newID(t)
	ua, _, _ := startUplink(t, ctx, a, id)
	ub, _, _ := startUplink(t, ctx, b, id)
	settled := make(chan []string, 1)
	racer := relay.Racer{Settled: func(closed []string) { settled <- closed }}
	c, used, err := racer.Dial(ctx, []string{a.URL, b.URL}, id.NodeID())
	if err != nil {
		t.Fatal(err)
	}
	winner, loser := ua, ub
	if used == b.URL {
		winner, loser = ub, ua
	}
	c.Send([]byte{0x01})
	w, _ := winner.Accept(ctx)
	if p, err := w.Recv(ctx); err != nil || len(p) != 1 {
		t.Fatalf("winner got %x, %v", p, err)
	}
	closed := <-settled
	loserURL := b.URL
	if used == b.URL {
		loserURL = a.URL
	}
	// The settle report bounds the loser's Accept: a socket the race closed with 1000 was
	// accepted by its relay, which sent OPEN; with no such socket no OPEN can come.
	actx, stop := context.WithCancel(ctx)
	defer stop()
	if len(closed) != 1 || closed[0] != loserURL {
		stop()
		t.Fatalf("closed %v, want the loser %s", closed, loserURL)
	}
	l, err := loser.Accept(actx)
	if err != nil {
		t.Fatalf("loser relay sent no OPEN: %v", err)
	}
	if p, err := l.Recv(ctx); relay.CodeOf(err) != wire.CodeNormal {
		t.Fatalf("loser got %x, %v; want CLOSE 1000 and no byte", p, err)
	}
}

func TestDialRaceGivesUpAtItsOwnDeadlineWhenARelayNeverAnswers(t *testing.T) {
	t.Parallel()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			defer c.Close() // accepted and never answered
		}
	}()
	id := newID(t)
	racer := relay.Racer{Timeout: 200 * time.Millisecond}
	if _, _, err := racer.Dial(context.Background(), []string{"http://" + ln.Addr().String()}, id.NodeID()); err == nil {
		t.Fatal("a relay that never answered won the race")
	}
}

func TestRaceTraceShowsTheWinnersStagesAndTheOfflineRelays4404(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	offline, online := relaytest.New(), relaytest.New()
	defer offline.Close()
	defer online.Close()
	id := newID(t)
	startUplink(t, ctx, online, id)
	race := func(relays ...string) map[string][]string {
		var mu sync.Mutex
		events := map[string][]string{}
		settled := make(chan struct{})
		racer := relay.Racer{
			Trace: func(event, url string, _ time.Duration) {
				mu.Lock()
				events[url] = append(events[url], event)
				mu.Unlock()
			},
			Settled: func([]string) { close(settled) },
		}
		racer.Dial(ctx, relays, id.NodeID())
		<-settled
		mu.Lock()
		defer mu.Unlock()
		return events
	}
	if got := race(online.URL)[online.URL]; !slices.Equal(got, []string{"ws", "pong", "winner"}) {
		t.Fatalf("online relay trace %v, want ws pong winner", got)
	}
	if got := race(offline.URL)[offline.URL]; !slices.Equal(got, []string{"ws", "closed 4404"}) {
		t.Fatalf("offline relay trace %v, want ws closed 4404", got)
	}
}

// freezer is a TCP proxy to a relay that can freeze the connections it holds: bytes stop moving
// both ways and nothing closes, as when a network path dies silently (a laptop asleep, a NAT gone).
type freezer struct {
	URL    string
	mu     sync.Mutex
	frozen chan struct{}
}

func newFreezer(t *testing.T, target string) *freezer {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	f := &freezer{URL: "http://" + ln.Addr().String(), frozen: make(chan struct{})}
	addr := strings.TrimPrefix(target, "http://")
	pump := func(dst, src net.Conn, frozen chan struct{}) {
		buf := make([]byte, 32<<10)
		for {
			n, err := src.Read(buf)
			if err != nil {
				dst.Close()
				return
			}
			select {
			case <-frozen:
				return // keep both ends open and silent
			default:
			}
			if _, err := dst.Write(buf[:n]); err != nil {
				src.Close()
				return
			}
		}
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			up, err := net.Dial("tcp", addr)
			if err != nil {
				c.Close()
				continue
			}
			t.Cleanup(func() { c.Close(); up.Close() })
			f.mu.Lock()
			frozen := f.frozen
			f.mu.Unlock()
			go pump(up, c, frozen)
			go pump(c, up, frozen)
		}
	}()
	return f
}

// freeze silences every connection made so far; later ones flow.
func (f *freezer) freeze() {
	f.mu.Lock()
	close(f.frozen)
	f.frozen = make(chan struct{})
	f.mu.Unlock()
}

func TestAnUplinkThatHearsNothingForTwoPingIntervalsRedials(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	fz := newFreezer(t, rs.URL)
	id := newID(t)
	u := relay.NewUplink(fz.URL, id)
	u.MinBackoff = time.Millisecond
	u.PingInterval = 20 * time.Millisecond
	ev := make(upEvents, 16)
	u.OnState = func(up bool) { ev <- up }
	go u.Run(ctx)
	if !<-ev {
		t.Fatal("uplink did not come up")
	}
	fz.freeze()
	if up := <-ev; up {
		t.Fatal("expected the silent uplink to go down")
	}
	if up := <-ev; !up {
		t.Fatal("expected the uplink back on a fresh connection")
	}
	if err := rs.WaitOnline(ctx, id.NodeID()); err != nil {
		t.Fatal(err)
	}
}

func TestAQuietUplinkWhoseRelayAnswersPingsStaysUp(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	id := newID(t)
	u := relay.NewUplink(rs.URL, id)
	u.MinBackoff = time.Millisecond
	u.PingInterval = 50 * time.Millisecond
	ev := make(upEvents, 16)
	u.OnState = func(up bool) { ev <- up }
	go u.Run(ctx)
	if !<-ev {
		t.Fatal("uplink did not come up")
	}
	// Six pings span three silence deadlines; only pongs arrive in between.
	for range 6 {
		if err := rs.NextUplinkPing(ctx, id.NodeID()); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case up := <-ev:
		t.Fatalf("a quiet uplink whose relay answers every ping changed state (up=%v)", up)
	default:
	}
}
