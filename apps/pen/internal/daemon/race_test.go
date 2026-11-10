package daemon

import (
	"context"
	"io"
	"net"
	"slices"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/state"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// founderOn makes a node with a new mesh whose uplinks are on every relay in rss.
func founderOn(t *testing.T, ctx context.Context, name string, rss ...*relaytest.Server) *node {
	t.Helper()
	st := shortDir(t)
	id, _, err := st.EnsureIdentity()
	if err != nil {
		t.Fatal(err)
	}
	var urls []string
	for _, rs := range rss {
		urls = append(urls, rs.URL)
	}
	var cfg state.Config
	cfg.Name = name
	cfg.SetRelays(urls)
	if err := st.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	if _, err := mesh.Found(st, id, name, 1); err != nil {
		t.Fatal(err)
	}
	n := startWith(t, ctx, rss[0], st, func(*Options) {})
	for _, rs := range rss[1:] {
		if err := rs.WaitOnline(ctx, n.d.NodeID()); err != nil {
			t.Fatal(err)
		}
	}
	return n
}

// raceTrace records trace events per relay and lets a test wait for one.
type raceTrace struct {
	mu     sync.Mutex
	events map[string][]string
	wake   chan struct{}
}

func newRaceTrace() *raceTrace {
	return &raceTrace{events: map[string][]string{}, wake: make(chan struct{}, 1)}
}

func (r *raceTrace) trace(event, url string, _ time.Duration) {
	r.mu.Lock()
	r.events[url] = append(r.events[url], event)
	r.mu.Unlock()
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

func (r *raceTrace) of(url string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.events[url])
}

// winner is the relay a "winner" event named, or "".
func (r *raceTrace) winner() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	for url, evs := range r.events {
		if slices.Contains(evs, "winner") {
			return url
		}
	}
	return ""
}

// waitFor returns once url's trace holds one of events, and returns that event.
func (r *raceTrace) waitFor(ctx context.Context, url string, events ...string) string {
	for {
		for _, ev := range r.of(url) {
			if slices.Contains(events, ev) {
				return ev
			}
		}
		select {
		case <-r.wake:
		case <-ctx.Done():
			return ""
		}
	}
}

func TestHandshakeRacePicksTheRelayWhoseNodeAnswersFirst(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ra, rb := relaytest.New(), relaytest.New()
	defer ra.Close()
	defer rb.Close()
	a := founderOn(t, ctx, "a", ra, rb)
	b := joiner(t, ctx, ra, a.invite(t, time.Minute), "b")
	// ra answers pong but holds what clients send for the node; rb forwards but answers no pong.
	defer ra.HoldForwarding()()
	defer rb.HoldPongs()()
	tr := newRaceTrace()
	sec, err := OpenTCP(relay.WithTrace(ctx, tr.trace), []string{ra.URL, rb.URL}, b.id, memberNamed(t, b, "a"), echoServer(t))
	if err != nil {
		t.Fatal(err)
	}
	defer sec.Close(wire.CodeNormal)
	if got := tr.winner(); got != rb.URL {
		t.Fatalf("the race chose %s (trace %v / %v), want rb %s, the relay whose node answered first", got, tr.of(ra.URL), tr.of(rb.URL), rb.URL)
	}
}

// countingEcho is an echo server that reports each accepted connection's remote address.
func countingEcho(t *testing.T) (int, <-chan string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	accepted := make(chan string, 16)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			accepted <- c.RemoteAddr().String()
			go func() {
				io.Copy(c, c)
				c.Close()
			}()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, accepted
}

func TestHandshakeRaceLosersNeverOpenTheStream(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ra, rb := relaytest.New(), relaytest.New()
	defer ra.Close()
	defer rb.Close()
	a := founderOn(t, ctx, "a", ra, rb)
	b := joiner(t, ctx, ra, a.invite(t, time.Minute), "b")
	port, accepted := countingEcho(t)
	tr := newRaceTrace()
	sec, err := OpenTCP(relay.WithTrace(ctx, tr.trace), []string{ra.URL, rb.URL}, b.id, memberNamed(t, b, "a"), port)
	if err != nil {
		t.Fatal(err)
	}
	if err := sec.Send([]byte{0, 0, 0, 0}); err != nil {
		t.Fatal(err)
	}
	<-accepted
	// Every responder a ran has finished once its daemon stopped; a sentinel dial queued after them
	// bounds what the echo port can still accept from a.
	a.d.Stop()
	err = <-a.done
	a.done <- err
	sentinel, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		t.Fatal(err)
	}
	defer sentinel.Close()
	extra := 0
	for addr := range accepted {
		if addr == sentinel.LocalAddr().String() {
			break
		}
		extra++
	}
	if extra != 0 {
		t.Fatalf("the member's port saw %d connection(s) besides the stream (trace %v / %v)", extra, tr.of(ra.URL), tr.of(rb.URL))
	}
}

func TestANodesRefusalOnOneRelayEndsTheRace(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ra, rb := relaytest.New(), relaytest.New()
	defer ra.Close()
	defer rb.Close()
	a := founderOn(t, ctx, "a", ra, rb)
	// rb reaches the node only once released, after the race ended.
	release := rb.HoldForwarding()
	defer release()
	defer rb.HoldPongs()()
	stranger := newcomer(t)
	tr := newRaceTrace()
	self := a.ls(t).Members[0].Member
	_, err := OpenTCP(relay.WithTrace(ctx, tr.trace), []string{ra.URL, rb.URL}, stranger, self, 22)
	if relay.CodeOf(err) != wire.CodeNotAdmitted {
		t.Fatalf("got %v, want 4401", err)
	}
	release()
	if ev := tr.waitFor(ctx, rb.URL, "loser closed", "closed 4401", "closed 4408"); ev != "loser closed" {
		t.Fatalf("the slow relay ended with %q (trace %v), want the race to close it after the 4401", ev, tr.of(rb.URL))
	}
}

func TestJoinAndAccountSessionsKeepThePingRace(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ra, rb := relaytest.New(), relaytest.New()
	defer ra.Close()
	defer rb.Close()
	f := loginFake(t)
	a := founderOn(t, ctx, "a", ra, rb)
	bindTo(t, a, f, f.Key())
	tok := a.invite(t, time.Minute)
	// rb answers no pong, so the ping race picks ra; a handshake race could pick either.
	defer rb.HoldPongs()()

	tr := newRaceTrace()
	st := shortDir(t)
	id := identity(t, st, ra.URL, "b")
	if _, err := Join(relay.WithTrace(ctx, tr.trace), st, id, tok, "b"); err != nil {
		t.Fatal(err)
	}
	if got := tr.winner(); got != ra.URL || !slices.Contains(tr.of(ra.URL), "pong") {
		t.Fatalf("join (kind 0x03) chose %s with trace %v; want the ping race's pick ra", got, tr.of(ra.URL))
	}

	tr = newRaceTrace()
	c := newcomer(t)
	as := f.Issue(testSub, "me@example.com", c.SignPub, c.NoisePub, time.Now())
	if _, _, err := AccountJoin(relay.WithTrace(ctx, tr.trace), []string{ra.URL, rb.URL}, c, "c", as, offeredBy(t, a)); err != nil {
		t.Fatal(err)
	}
	if got := tr.winner(); got != ra.URL || !slices.Contains(tr.of(ra.URL), "pong") {
		t.Fatalf("account join (kind 0x04) chose %s with trace %v; want the ping race's pick ra", got, tr.of(ra.URL))
	}
}
