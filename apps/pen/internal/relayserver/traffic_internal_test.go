package relayserver

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

// Shutting the relay down writes the totals once more and stops the summary timer for good: a
// stopped relay holds no timer, and no later session arms one.
func TestCloseWritesTheTotalsAndStopsTheSummaryTimer(t *testing.T) {
	lv, _, log := trafficLive(t)
	id, _ := ident.Generate(rand.Reader)
	n := lv.uplink(id, true)
	c, sid := lv.session(t, n)
	send(t, c, 42)
	n.nextFrame(t, sid)
	lv.s.traffic.mu.Lock()
	armed := lv.s.traffic.timer != nil
	lv.s.traffic.mu.Unlock()
	if !armed {
		t.Fatal("an admitted session did not arm the summary timer")
	}
	lv.s.Close()
	relay := log.lines(t, "relay")
	if len(relay) != 1 || relay[0]["toNode"] != float64(42) {
		t.Fatalf("relay lines after Close: %v", relay)
	}
	lv.s.traffic.mu.Lock()
	stillArmed := lv.s.traffic.timer.Stop()
	lv.s.traffic.mu.Unlock()
	if stillArmed {
		t.Fatal("the summary timer was still armed after Close")
	}
	// A relay closed before its first session never arms the timer.
	early := New(DefaultLimits())
	early.TrafficLog = &lineLog{}
	early.Close()
	early.trafficStart()
	early.traffic.mu.Lock()
	defer early.traffic.mu.Unlock()
	if early.traffic.timer != nil {
		t.Fatal("a session after Close armed the summary timer")
	}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// lineLog is a traffic log the test reads back.
type lineLog struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *lineLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *lineLog) raw() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

// lines parses every line, failing on one that is not a JSON object, and returns those of event.
func (l *lineLog) lines(t *testing.T, event string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, s := range strings.Split(strings.TrimSpace(l.raw()), "\n") {
		if s == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(s), &m); err != nil {
			t.Fatalf("traffic line is not JSON: %q", s)
		}
		if m["event"] == event {
			out = append(out, m)
		}
	}
	return out
}

func trafficLive(t *testing.T) (*live, *fakeClock, *lineLog) {
	lv := newLive(t, DefaultLimits())
	clk := &fakeClock{t: time.Date(2026, 11, 12, 0, 0, 0, 0, time.UTC)}
	log := &lineLog{}
	lv.s.TrafficLog = log
	lv.s.traffic.now = clk.Now
	return lv, clk, log
}

// socketsDone waits until n more sockets have ended on the relay.
func (lv *live) socketsDone(t *testing.T, n int) {
	t.Helper()
	for range n {
		select {
		case <-lv.done:
		case <-time.After(failsafe):
			t.Fatal("a socket never ended on the relay")
		}
	}
}

// nextFrame is the next DATA or CLOSE frame the node receives for sid.
func (n *liveNode) nextFrame(t *testing.T, sid uint32) wire.Frame {
	t.Helper()
	for {
		select {
		case f := <-n.frames:
			if f.SID == sid {
				return f
			}
		case <-time.After(failsafe):
			t.Fatalf("no frame for session %d reached the node", sid)
		}
	}
}

func (n *liveNode) data(t *testing.T, sid uint32, size int) {
	t.Helper()
	n.ws.Write(context.Background(), websocket.MessageBinary, wire.Frame{Type: wire.FrameData, SID: sid, Payload: make([]byte, size)}.Encode())
}

func send(t *testing.T, c *websocket.Conn, size int) {
	t.Helper()
	if err := c.Write(context.Background(), websocket.MessageBinary, make([]byte, size)); err != nil {
		t.Fatal(err)
	}
}

func receive(t *testing.T, c *websocket.Conn, size int) {
	t.Helper()
	_, p, err := c.Read(context.Background())
	if err != nil || len(p) != size {
		t.Fatalf("client read %d bytes (%v), want %d", len(p), err, size)
	}
}

// session dials a session to n and returns its client socket and sid.
func (lv *live) session(t *testing.T, n *liveNode) (*websocket.Conn, uint32) {
	t.Helper()
	c := lv.dial("/v1/client/" + n.id.NodeID())
	if c == nil {
		t.Fatal("client refused")
	}
	return c, n.nextOpen(t)
}

func wantSession(t *testing.T, got map[string]any, node string, to, from int, ms int, end string, code int) {
	t.Helper()
	want := map[string]any{"event": "session", "node": node, "toNode": float64(to), "fromNode": float64(from),
		"ms": float64(ms), "end": end, "code": float64(code), "at": got["at"]}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("session line\n got %v\nwant %v", got, want)
	}
}

// The line of a session the node answered carries the payload bytes the relay passed each way,
// its duration and how it ended.
func TestASessionLineCountsTheBytesRelayedEachWay(t *testing.T) {
	lv, clk, log := trafficLive(t)
	id, _ := ident.Generate(rand.Reader)
	n := lv.uplink(id, true)
	c, sid := lv.session(t, n)
	send(t, c, 1000)
	n.nextFrame(t, sid)
	n.data(t, sid, 3000)
	receive(t, c, 3000)
	send(t, c, 70000)
	n.nextFrame(t, sid)
	clk.Add(2500 * time.Millisecond)
	c.Close(websocket.StatusNormalClosure, "")
	lv.socketsDone(t, 1)
	got := log.lines(t, "session")
	if len(got) != 1 {
		t.Fatalf("%d session lines, want 1:\n%s", len(got), log.raw())
	}
	wantSession(t, got[0], id.NodeID()[:8], 71000, 3000, 2500, "client", 1000)
}

// A client that drops its connection mid-stream: the line counts what the relay passed up to the
// cut, and DATA the node sends after it is not counted.
func TestAClientCutMidStreamCountsWhatWasRelayedBeforeTheCut(t *testing.T) {
	lv, clk, log := trafficLive(t)
	id, _ := ident.Generate(rand.Reader)
	n := lv.uplink(id, true)
	c, sid := lv.session(t, n)
	send(t, c, 500)
	n.nextFrame(t, sid)
	n.data(t, sid, 4000)
	n.data(t, sid, 5000)
	receive(t, c, 4000)
	receive(t, c, 5000)
	send(t, c, 20000)
	n.nextFrame(t, sid)
	clk.Add(time.Second)
	c.CloseNow()
	if f := n.nextFrame(t, sid); f.Type != wire.FrameClose {
		t.Fatalf("the node got frame type %d after the cut, want CLOSE", f.Type)
	}
	n.data(t, sid, 7000)
	// The relay handles uplink frames in order: once a later session's DATA arrives, the frame
	// for the cut session has been handled.
	c2, sid2 := lv.session(t, n)
	n.data(t, sid2, 10)
	receive(t, c2, 10)
	lv.socketsDone(t, 1)
	got := log.lines(t, "session")
	if len(got) != 1 {
		t.Fatalf("%d session lines, want 1:\n%s", len(got), log.raw())
	}
	wantSession(t, got[0], id.NodeID()[:8], 20500, 9000, 1000, "client", 1006)
}

// An uplink lost mid-stream ends its sessions 4404; each line counts what was relayed until then.
func TestAnUplinkLostMidStreamEndsTheSessionLineWithWhatWasRelayed(t *testing.T) {
	lv, clk, log := trafficLive(t)
	id, _ := ident.Generate(rand.Reader)
	n := lv.uplink(id, true)
	c, sid := lv.session(t, n)
	send(t, c, 100)
	n.nextFrame(t, sid)
	n.data(t, sid, 6000)
	receive(t, c, 6000)
	send(t, c, 9000)
	n.nextFrame(t, sid)
	clk.Add(1500 * time.Millisecond)
	lv.s.DropUplink(id.NodeID())
	if _, _, err := c.Read(context.Background()); websocket.CloseStatus(err) != 4404 {
		t.Fatalf("client read %v, want close 4404", err)
	}
	lv.socketsDone(t, 2)
	got := log.lines(t, "session")
	if len(got) != 1 {
		t.Fatalf("%d session lines, want 1:\n%s", len(got), log.raw())
	}
	wantSession(t, got[0], id.NodeID()[:8], 9100, 6000, 1500, "uplink", 4404)
}

func keys(m map[string]any) []string {
	k := make([]string, 0, len(m))
	for key := range m {
		k = append(k, key)
	}
	slices.Sort(k)
	return k
}

// Every line has exactly its documented fields; a node appears only as its 8-character prefix and
// no address or port of either end appears anywhere.
func TestTrafficLinesHoldOnlyTheirFieldsAndTheNodeIDPrefix(t *testing.T) {
	lv, clk, log := trafficLive(t)
	id, _ := ident.Generate(rand.Reader)
	n := lv.uplink(id, true)
	c, sid := lv.session(t, n)
	send(t, c, 10)
	n.nextFrame(t, sid)
	n.data(t, sid, 10)
	receive(t, c, 10)
	clk.Add(time.Second)
	c.Close(websocket.StatusNormalClosure, "")
	lv.socketsDone(t, 1)
	lv.s.Summarize()
	want := map[string][]string{
		"session": {"at", "code", "end", "event", "fromNode", "ms", "node", "toNode"},
		"node":    {"at", "event", "fromNode", "node", "sessions", "since", "toNode"},
		"relay":   {"at", "event", "evicted", "fromNode", "linesDropped", "nodes", "sessions", "since", "toNode", "unanswered"},
	}
	for event, fields := range want {
		lines := log.lines(t, event)
		if len(lines) != 1 {
			t.Fatalf("%d %s lines, want 1:\n%s", len(lines), event, log.raw())
		}
		if got := keys(lines[0]); !slices.Equal(got, fields) {
			t.Errorf("%s line fields %v, want %v", event, got, fields)
		}
		if node, ok := lines[0]["node"]; ok && node != id.NodeID()[:NodePrefixLen] {
			t.Errorf("%s line node %v, want %s", event, node, id.NodeID()[:NodePrefixLen])
		}
	}
	raw := log.raw()
	host := strings.TrimPrefix(lv.url, "http://")
	_, port, _ := strings.Cut(host, ":")
	for _, secret := range []string{id.NodeID(), id.NodeID()[:NodePrefixLen+1], "127.0.0.1", host, ":" + port} {
		if strings.Contains(raw, secret) {
			t.Errorf("traffic log contains %q:\n%s", secret, raw)
		}
	}
}

// Long sessions show in the totals before they end, without being counted twice when they do;
// a summary with nothing new writes nothing.
func TestSummariesCountOpenSessionsOnceAndStaySilentWhenNothingChanged(t *testing.T) {
	lv, clk, log := trafficLive(t)
	id, _ := ident.Generate(rand.Reader)
	n := lv.uplink(id, true)
	c, sid := lv.session(t, n)
	send(t, c, 300)
	n.nextFrame(t, sid)
	n.data(t, sid, 800)
	receive(t, c, 800)
	lv.s.Summarize()
	nodes := log.lines(t, "node")
	if len(nodes) != 1 || nodes[0]["toNode"] != float64(300) || nodes[0]["fromNode"] != float64(800) || nodes[0]["sessions"] != float64(0) {
		t.Fatalf("node lines after the first summary: %v", nodes)
	}
	before := log.raw()
	clk.Add(SummaryEvery)
	lv.s.Summarize()
	if log.raw() != before {
		t.Fatalf("a summary with nothing new wrote:\n%s", strings.TrimPrefix(log.raw(), before))
	}
	send(t, c, 2000)
	n.nextFrame(t, sid)
	c.Close(websocket.StatusNormalClosure, "")
	lv.socketsDone(t, 1)
	lv.s.Summarize()
	nodes = log.lines(t, "node")
	last := nodes[len(nodes)-1]
	if len(nodes) != 2 || last["toNode"] != float64(2300) || last["fromNode"] != float64(800) || last["sessions"] != float64(1) {
		t.Fatalf("node lines after the session ended: %v", nodes)
	}
	relay := log.lines(t, "relay")
	if r := relay[len(relay)-1]; r["toNode"] != float64(2300) || r["fromNode"] != float64(800) || r["sessions"] != float64(1) {
		t.Fatalf("relay line %v", r)
	}
}

// However many nodes pass through the relay, it tracks at most MaxTrackedNodes, dropping the least
// recently active, while the relay-wide totals keep every byte.
func TestTotalsTrackAtMostMaxTrackedNodesAndDropTheLeastRecentlyActive(t *testing.T) {
	clk := &fakeClock{t: time.Date(2026, 11, 12, 0, 0, 0, 0, time.UTC)}
	tr := &traffic{now: clk.Now}
	log := &lineLog{}
	const nodes, rounds = 1000, 3
	for range rounds {
		for i := range nodes {
			clk.Add(time.Millisecond)
			tr.ended(log, sessionEnd{node: fmt.Sprintf("n%07d", i), toNode: 3, fromNode: 5, newTo: 3, newFrom: 5,
				answered: true, ended: clk.Now(), by: "client", code: 1000})
		}
	}
	tr.mu.Lock()
	tracked, relay := len(tr.nodes), tr.relay
	_, newest := tr.nodes[fmt.Sprintf("n%07d", nodes-1)]
	_, oldest := tr.nodes["n0000000"]
	tr.mu.Unlock()
	if tracked != MaxTrackedNodes || !newest || oldest {
		t.Fatalf("tracked %d nodes (newest %v, oldest %v), want %d with the newest", tracked, newest, oldest, MaxTrackedNodes)
	}
	total := uint64(nodes * rounds)
	if relay.sessions != total || relay.toNode != 3*total || relay.fromNode != 5*total || relay.evicted != total-MaxTrackedNodes {
		t.Fatalf("relay totals %+v after %d sessions", relay, total)
	}
}

// Strangers cannot grow what the relay keeps or logs: uplinks that never authenticate and
// sessions the node never answers write no line and track nothing new, and a flood of one-byte
// sessions writes at most the burst of lines while the totals count every byte.
func TestFloodsOfUnansweredAndOneByteSessionsStayWithinTheBounds(t *testing.T) {
	lv, _, log := trafficLive(t)
	lv.s.traffic.burst = 5
	for range 20 {
		stranger, _ := ident.Generate(rand.Reader)
		if lv.uplink(stranger, false) == nil {
			t.Fatal("an unauthenticated uplink was refused before its challenge")
		}
	}
	id, _ := ident.Generate(rand.Reader)
	n := lv.uplink(id, true)
	const unanswered, oneByte = 100, 50
	for range unanswered {
		c, sid := lv.session(t, n)
		send(t, c, 1)
		n.nextFrame(t, sid)
		c.Close(websocket.StatusNormalClosure, "")
		lv.socketsDone(t, 1)
	}
	for range oneByte {
		c, sid := lv.session(t, n)
		send(t, c, 1)
		n.nextFrame(t, sid)
		n.data(t, sid, 1)
		receive(t, c, 1)
		c.Close(websocket.StatusNormalClosure, "")
		lv.socketsDone(t, 1)
	}
	if got := len(log.lines(t, "session")); got != 5 {
		t.Fatalf("%d session lines, want the burst of 5", got)
	}
	lv.s.traffic.mu.Lock()
	tracked, relay := len(lv.s.traffic.nodes), lv.s.traffic.relay
	lv.s.traffic.mu.Unlock()
	if tracked != 1 || relay.unanswered != unanswered || relay.sessions != oneByte || relay.linesDropped != oneByte-5 ||
		relay.toNode != unanswered+oneByte || relay.fromNode != oneByte {
		t.Fatalf("tracked %d nodes, relay totals %+v", tracked, relay)
	}
}
