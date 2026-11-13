package relayserver

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
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

// lineLog is a traffic log the test reads back once the relay's log writer has caught up.
type lineLog struct {
	srv *Server
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *lineLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *lineLog) raw() string {
	if l.srv != nil {
		syncLog(l.srv)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

// syncLog returns once the log writer has written every line queued so far.
func syncLog(s *Server) {
	s.traffic.mu.Lock()
	q := s.traffic.lines
	if q == nil || s.traffic.closed {
		s.traffic.mu.Unlock()
		return
	}
	ack := make(chan struct{})
	q <- logItem{ack: ack}
	s.traffic.mu.Unlock()
	<-ack
}

// parse returns the lines of event in raw, failing on a line that is not a JSON object.
func parse(t *testing.T, raw, event string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, s := range strings.Split(strings.TrimSpace(raw), "\n") {
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

func (l *lineLog) lines(t *testing.T, event string) []map[string]any {
	t.Helper()
	return parse(t, l.raw(), event)
}

// trafficLive is a live relay with a traffic log and an injected clock; listed nodes get totals.
func trafficLive(t *testing.T, listed ...*ident.Identity) (*live, *fakeClock, *lineLog) {
	lv := newLive(t, DefaultLimits())
	clk := &fakeClock{t: time.Date(2026, 11, 12, 0, 0, 0, 0, time.UTC)}
	log := &lineLog{srv: lv.s}
	lv.s.TrafficLog = log
	lv.s.TrafficNodes = map[string]bool{}
	for _, id := range listed {
		lv.s.TrafficNodes[id.NodeID()] = true
	}
	lv.s.traffic.now = clk.Now
	return lv, clk, log
}

func newID(t *testing.T) *ident.Identity {
	t.Helper()
	id, err := ident.Generate(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return id
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

// sessionsCounted waits until n more sessions' bytes have reached the traffic totals: a session is
// counted once its client socket is done and the uplink has written its last frame.
func (lv *live) sessionsCounted(t *testing.T, n int) {
	t.Helper()
	for range n {
		select {
		case <-lv.counted:
		case <-time.After(failsafe):
			t.Fatal("a session was never counted")
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

// The relay writes one socket's messages in order and counts a data message only after its write returns, so a
// peer can read data before it is counted. A pong comes behind everything queued before it and is never counted:
// once a socket's pong arrives, all data written to that socket so far is in the totals.

// counted waits until the data the relay wrote to client socket c so far is counted.
func counted(t *testing.T, c *websocket.Conn) {
	t.Helper()
	ctx := context.Background()
	if err := c.Write(ctx, websocket.MessageText, []byte("ping")); err != nil {
		t.Fatal(err)
	}
	if typ, p, err := c.Read(ctx); err != nil || typ != websocket.MessageText || string(p) != "pong" {
		t.Fatalf("client read %q (%v) after its ping, want pong", p, err)
	}
}

// counted waits until the data the relay wrote to the node's uplink so far is counted.
func (n *liveNode) counted(t *testing.T) {
	t.Helper()
	if err := n.ws.Write(context.Background(), websocket.MessageText, []byte("ping")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-n.pongs:
	case <-time.After(failsafe):
		t.Fatal("no pong reached the node")
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

// exchange runs one answered session of one byte each way and waits until it has ended.
func (lv *live) exchange(t *testing.T, n *liveNode) {
	t.Helper()
	c, sid := lv.session(t, n)
	send(t, c, 1)
	n.nextFrame(t, sid)
	n.data(t, sid, 1)
	receive(t, c, 1)
	c.Close(websocket.StatusNormalClosure, "")
	lv.socketsDone(t, 1)
	lv.sessionsCounted(t, 1)
}

func wantSession(t *testing.T, got map[string]any, node string, to, from int, ms int, end string, code int) {
	t.Helper()
	want := map[string]any{"event": "session", "node": node, "toNode": float64(to), "fromNode": float64(from),
		"ms": float64(ms), "end": end, "code": float64(code), "at": got["at"]}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("session line\n got %v\nwant %v", got, want)
	}
}

func onlyLine(t *testing.T, log *lineLog, event string) map[string]any {
	t.Helper()
	got := log.lines(t, event)
	if len(got) != 1 {
		t.Fatalf("%d %s lines, want 1:\n%s", len(got), event, log.raw())
	}
	return got[0]
}

// The line of a session the node answered carries the payload bytes the relay delivered each way,
// its duration and how it ended.
func TestASessionLineCountsTheBytesRelayedEachWay(t *testing.T) {
	id := newID(t)
	lv, clk, log := trafficLive(t, id)
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
	lv.sessionsCounted(t, 1)
	wantSession(t, onlyLine(t, log, "session"), id.NodeID()[:8], 71000, 3000, 2500, "client", 1000)
}

// A client that drops its connection mid-stream: the line counts what the relay passed up to the
// cut, and DATA the node sends after it is not counted.
func TestAClientCutMidStreamCountsWhatWasRelayedBeforeTheCut(t *testing.T) {
	id := newID(t)
	lv, clk, log := trafficLive(t, id)
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
	lv.sessionsCounted(t, 1)
	wantSession(t, onlyLine(t, log, "session"), id.NodeID()[:8], 20500, 9000, 1000, "client", 1006)
}

// An uplink lost mid-stream ends its sessions 4404; each line counts what was relayed until then.
func TestAnUplinkLostMidStreamEndsTheSessionLineWithWhatWasRelayed(t *testing.T) {
	id := newID(t)
	lv, clk, log := trafficLive(t, id)
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
	lv.sessionsCounted(t, 1)
	wantSession(t, onlyLine(t, log, "session"), id.NodeID()[:8], 9100, 6000, 1500, "uplink", 4404)
}

// Bytes the relay accepted but never wrote to the other end are not counted: a client whose write
// fails, and an uplink whose write fails, with data queued for them.
func TestBytesAWriteNeverDeliveredAreNotCounted(t *testing.T) {
	id := newID(t)
	lv, _, log := trafficLive(t, id)
	n := lv.uplink(id, true)
	c, sid := lv.session(t, n)
	send(t, c, 100)
	n.nextFrame(t, sid)
	n.data(t, sid, 3000)
	receive(t, c, 3000)
	lv.mu.Lock()
	lv.stallNode, lv.stallSID = id.NodeID(), sid
	lv.mu.Unlock()
	n.data(t, sid, 4000)
	<-lv.stalled
	lv.socketsDone(t, 1)
	lv.sessionsCounted(t, 1)
	wantSession(t, onlyLine(t, log, "session"), id.NodeID()[:8], 100, 3000, 0, "client", 1006)

	c2, sid2 := lv.session(t, n)
	send(t, c2, 200)
	n.nextFrame(t, sid2)
	n.data(t, sid2, 10)
	receive(t, c2, 10)
	lv.mu.Lock()
	lv.stallUplink = id.NodeID()
	lv.mu.Unlock()
	send(t, c2, 500)
	<-lv.stalled
	lv.socketsDone(t, 2)
	lv.sessionsCounted(t, 1)
	sessions := log.lines(t, "session")
	if len(sessions) != 2 {
		t.Fatalf("%d session lines, want 2:\n%s", len(sessions), log.raw())
	}
	wantSession(t, sessions[1], id.NodeID()[:8], 200, 10, 0, "uplink", 4404)
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
	id := newID(t)
	lv, clk, log := trafficLive(t, id)
	n := lv.uplink(id, true)
	c, sid := lv.session(t, n)
	send(t, c, 10)
	n.nextFrame(t, sid)
	n.data(t, sid, 10)
	receive(t, c, 10)
	clk.Add(time.Second)
	c.Close(websocket.StatusNormalClosure, "")
	lv.socketsDone(t, 1)
	lv.sessionsCounted(t, 1)
	lv.s.Summarize()
	want := map[string][]string{
		"session": {"at", "code", "end", "event", "fromNode", "ms", "node", "toNode"},
		"node":    {"at", "event", "fromNode", "node", "sessions", "since", "toNode"},
		"relay":   {"at", "event", "fromNode", "linesDropped", "nodes", "sessions", "since", "toNode", "unanswered"},
	}
	for event, fields := range want {
		line := onlyLine(t, log, event)
		if got := keys(line); !slices.Equal(got, fields) {
			t.Errorf("%s line fields %v, want %v", event, got, fields)
		}
		if node, ok := line["node"]; ok && node != id.NodeID()[:NodePrefixLen] {
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
	id := newID(t)
	lv, clk, log := trafficLive(t, id)
	n := lv.uplink(id, true)
	c, sid := lv.session(t, n)
	send(t, c, 300)
	n.nextFrame(t, sid)
	n.data(t, sid, 800)
	receive(t, c, 800)
	n.counted(t)
	counted(t, c)
	lv.s.Summarize()
	nodes := log.lines(t, "node")
	if len(nodes) != 1 || nodes[0]["toNode"] != float64(300) || nodes[0]["fromNode"] != float64(800) || nodes[0]["sessions"] != float64(0) {
		t.Fatalf("node lines after the first summary: %v", nodes)
	}
	before := log.raw()
	clk.Add(SummaryEvery)
	lv.s.Summarize()
	if after := log.raw(); after != before {
		t.Fatalf("a summary with nothing new wrote:\n%s", strings.TrimPrefix(after, before))
	}
	send(t, c, 2000)
	n.nextFrame(t, sid)
	c.Close(websocket.StatusNormalClosure, "")
	lv.socketsDone(t, 1)
	lv.sessionsCounted(t, 1)
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

// Anyone can mint node ids, so only the nodes the operator lists get totals and session lines:
// many stranger nodes neither add entries nor lines, and the relay-wide totals still count them.
// With no list, the relay writes only its relay-wide totals.
func TestOnlyListedNodesGetTotalsAndSessionLines(t *testing.T) {
	listed := newID(t)
	lv, _, log := trafficLive(t, listed)
	lv.exchange(t, lv.uplink(listed, true))
	const strangers = 30
	for range strangers {
		lv.exchange(t, lv.uplink(newID(t), true))
	}
	lv.s.Summarize()
	if got := onlyLine(t, log, "session")["node"]; got != listed.NodeID()[:NodePrefixLen] {
		t.Fatalf("session line for %v, want only the listed node", got)
	}
	if got := onlyLine(t, log, "node")["node"]; got != listed.NodeID()[:NodePrefixLen] {
		t.Fatalf("node line for %v, want only the listed node", got)
	}
	relay := onlyLine(t, log, "relay")
	if relay["sessions"] != float64(strangers+1) || relay["toNode"] != float64(strangers+1) || relay["nodes"] != float64(1) {
		t.Fatalf("relay line %v, want %d sessions over 1 tracked node", relay, strangers+1)
	}

	open, _, openLog := trafficLive(t)
	open.exchange(t, open.uplink(newID(t), true))
	open.s.Summarize()
	if len(openLog.lines(t, "session")) != 0 || len(openLog.lines(t, "node")) != 0 {
		t.Fatalf("a relay with no list wrote node or session lines:\n%s", openLog.raw())
	}
	if r := onlyLine(t, openLog, "relay"); r["sessions"] != float64(1) || r["nodes"] != float64(0) {
		t.Fatalf("relay line %v with no list", r)
	}
}

// Strangers cannot grow what the relay keeps or logs: uplinks that never authenticate and
// sessions the node never answers write no line, and a flood of one-byte sessions writes at most
// the burst of lines while the totals count every byte.
func TestFloodsOfUnansweredAndOneByteSessionsStayWithinTheBounds(t *testing.T) {
	id := newID(t)
	lv, _, log := trafficLive(t, id)
	lv.s.traffic.burst = 5
	for range 20 {
		if lv.uplink(newID(t), false) == nil {
			t.Fatal("an unauthenticated uplink was refused before its challenge")
		}
	}
	n := lv.uplink(id, true)
	const unanswered, oneByte = 100, 50
	for range unanswered {
		c, sid := lv.session(t, n)
		send(t, c, 1)
		n.nextFrame(t, sid)
		c.Close(websocket.StatusNormalClosure, "")
		lv.socketsDone(t, 1)
		lv.sessionsCounted(t, 1)
	}
	for range oneByte {
		lv.exchange(t, n)
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

// blockedLog is a log whose writes wait until the test opens its gate.
type blockedLog struct {
	lineLog
	gate chan struct{}
}

func (b *blockedLog) Write(p []byte) (int, error) {
	<-b.gate
	return b.lineLog.Write(p)
}

// A log that stops taking lines holds no session handler: sessions keep ending, lines past the
// queue are dropped and counted, the totals stay exact, and Close returns at its deadline.
func TestABlockedLogHoldsNoHandlerAndCloseStaysBounded(t *testing.T) {
	id := newID(t)
	lv := newLive(t, DefaultLimits())
	log := &blockedLog{gate: make(chan struct{})}
	var open sync.Once
	release := func() { open.Do(func() { close(log.gate) }) }
	t.Cleanup(release)
	lv.s.TrafficLog = log
	lv.s.TrafficNodes = map[string]bool{id.NodeID(): true}
	lv.s.traffic.burst = 1000
	lv.s.traffic.queue = 8
	// Each deadline fires once and at once, as an expired timer's channel does.
	lv.s.traffic.after = func(time.Duration) (<-chan time.Time, func() bool) {
		fired := make(chan time.Time, 1)
		fired <- time.Time{}
		return fired, func() bool { return false }
	}
	n := lv.uplink(id, true)
	const sessions = 20
	for range sessions {
		lv.exchange(t, n)
	}
	closed := make(chan struct{})
	go func() {
		lv.s.Close()
		close(closed)
	}()
	select {
	case <-closed:
	case <-time.After(failsafe):
		t.Fatal("Close did not return while the log was blocked")
	}
	release()
	select {
	case <-lv.s.traffic.written:
	case <-time.After(failsafe):
		t.Fatal("the log writer never finished")
	}
	lv.s.traffic.mu.Lock()
	relay := lv.s.traffic.relay
	lv.s.traffic.mu.Unlock()
	if relay.sessions != sessions || relay.toNode != sessions || relay.fromNode != sessions {
		t.Fatalf("relay totals %+v, want %d sessions of one byte each way", relay, sessions)
	}
	raw := log.lineLog.raw()
	written := len(parse(t, raw, "session")) + len(parse(t, raw, "node")) + len(parse(t, raw, "relay"))
	// Each session's line, then the final node and relay lines, each written or dropped once; the
	// writer holds one line and the queue eight.
	if attempted := sessions + 2; written+int(relay.linesDropped) != attempted || written > 9 {
		t.Fatalf("%d lines written and %d dropped, want %d in all with at most 9 written", written, relay.linesDropped, attempted)
	}
}

// Sessions that a shutdown ends report their bytes before the last summary: once Close returns,
// their lines are written and the final relay line counts them.
func TestCloseCountsTheSessionsItEndsInTheFinalSummary(t *testing.T) {
	id := newID(t)
	lv, _, log := trafficLive(t, id)
	n := lv.uplink(id, true)
	c, sid := lv.session(t, n)
	send(t, c, 300)
	n.nextFrame(t, sid)
	n.data(t, sid, 700)
	receive(t, c, 700)
	lv.s.Close()
	relay := log.lines(t, "relay")
	if len(relay) == 0 {
		t.Fatalf("no relay line once Close returned:\n%s", log.raw())
	}
	if last := relay[len(relay)-1]; last["sessions"] != float64(1) || last["toNode"] != float64(300) || last["fromNode"] != float64(700) {
		t.Fatalf("final relay line %v, want the ended session counted", last)
	}
	wantSession(t, onlyLine(t, log, "session"), id.NodeID()[:8], 300, 700, 0, "relay", 1001)
}

// Shutting the relay down writes the totals once more and stops the summary timer for good: a
// stopped relay holds no timer, and no later session arms one.
func TestCloseWritesTheTotalsAndStopsTheSummaryTimer(t *testing.T) {
	id := newID(t)
	lv, _, log := trafficLive(t, id)
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
	if r := onlyLine(t, log, "relay"); r["toNode"] != float64(42) {
		t.Fatalf("relay line after Close: %v", r)
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

// The first side to end a session names how it ended: a client abort handled after the shutdown
// recorded its code does not overwrite it.
func TestAClientAbortAfterTheShutdownKeepsTheShutdownsCode(t *testing.T) {
	s := New(DefaultLimits())
	rm := &room{srv: s, clients: map[uint32]*sock{}}
	testSock(s, rm, roleNode, 0, "192.0.2.1", stalled(t))
	c := testSock(s, rm, roleClient, 1, "192.0.2.2", stalled(t))
	rm.mu.Lock()
	c.endedBy, c.endCode = "relay", uint16(websocket.StatusGoingAway)
	rm.mu.Unlock()
	rm.peerGone(c, 1006)
	rm.mu.Lock()
	defer rm.mu.Unlock()
	if c.endedBy != "relay" || c.endCode != uint16(websocket.StatusGoingAway) {
		t.Fatalf("session ended as %s %d, want relay 1001", c.endedBy, c.endCode)
	}
}

// gatedWS is a socket whose writes wait for the test: entered receives as a write starts, and the
// write returns once release receives.
type gatedWS struct{ entered, release chan struct{} }

func (w *gatedWS) Write(context.Context, websocket.MessageType, []byte) error {
	w.entered <- struct{}{}
	<-w.release
	return nil
}
func (w *gatedWS) Close(websocket.StatusCode, string) error { return nil }
func (w *gatedWS) CloseNow() error                          { return nil }

// A frame that is being written when another goroutine drops the uplink's queue still counts once
// its write succeeds: the session is not counted before that write's result is known.
func TestAnInFlightWriteCountsAfterTheQueueIsDropped(t *testing.T) {
	s := New(DefaultLimits())
	s.TrafficLog = &lineLog{}
	s.TrafficNodes = map[string]bool{}
	ws := &gatedWS{entered: make(chan struct{}), release: make(chan struct{})}
	q := newOutq(ws, time.Hour, nil)
	tally := &sessionTally{srv: s, node: "n0000000", answered: true}
	tally.refs.Store(1)
	if !q.track(7, tally) {
		t.Fatal("track refused")
	}
	q.offerFrame(7, make([]byte, 1234))
	<-ws.entered
	q.mu.Lock()
	q.dropLocked()
	q.mu.Unlock()
	tally.release()
	ws.release <- struct{}{}
	q.wait()
	s.traffic.mu.Lock()
	defer s.traffic.mu.Unlock()
	if s.traffic.relay.toNode != 1234 || s.traffic.relay.sessions != 1 {
		t.Fatalf("relay totals %+v, want the in-flight 1234 bytes counted", s.traffic.relay)
	}
}

// A summary whose lines did not fit the log queue is written again at the next summary, even when
// no traffic came in between.
func TestASummaryThatDidNotFitIsRetried(t *testing.T) {
	clk := &fakeClock{t: time.Date(2026, 11, 12, 0, 0, 0, 0, time.UTC)}
	tr := &traffic{now: clk.Now, lines: make(chan logItem, 1)}
	tr.mu.Lock()
	tr.addLocked("n0000000", true, 5, 7, 1, clk.Now())
	tr.mu.Unlock()
	tr.summarize(nil)
	first := <-tr.lines
	if !strings.Contains(string(first.b), "\"event\":\"node\"") {
		t.Fatalf("first queued line %s, want the node line", first.b)
	}
	clk.Add(SummaryEvery)
	tr.summarize(nil)
	select {
	case retried := <-tr.lines:
		if !strings.Contains(string(retried.b), "\"event\":\"relay\"") || !strings.Contains(string(retried.b), "\"linesDropped\":1") {
			t.Fatalf("retried line %s, want the relay line with its drop counted", retried.b)
		}
	default:
		t.Fatal("the relay line that did not fit was never queued again")
	}
}

// Close may be called more than once, also at the same time: the second call returns without
// harm.
func TestClosingTwiceIsHarmless(t *testing.T) {
	id := newID(t)
	lv, _, _ := trafficLive(t, id)
	lv.exchange(t, lv.uplink(id, true))
	var wg sync.WaitGroup
	for range 2 {
		wg.Go(lv.s.Close)
	}
	wg.Wait()
	lv.s.Close()
}

// failingLog fails its first fail writes, then keeps what it is given.
type failingLog struct {
	lineLog
	fail int
}

func (f *failingLog) Write(p []byte) (int, error) {
	f.mu.Lock()
	if f.fail > 0 {
		f.fail--
		f.mu.Unlock()
		return 0, errors.New("log unavailable")
	}
	f.mu.Unlock()
	return f.lineLog.Write(p)
}

// A line the log failed to take counts as dropped, and the totals it carried go out again at the
// next summary even when no traffic came in between.
func TestALineTheLogFailedToTakeIsCountedAndItsSummaryRetried(t *testing.T) {
	s := New(DefaultLimits())
	log := &failingLog{fail: 2}
	s.TrafficLog = log
	s.trafficStart()
	t.Cleanup(s.Close)
	s.traffic.mu.Lock()
	s.traffic.addLocked("n0000000", true, 5, 7, 1, time.Now())
	s.traffic.mu.Unlock()
	s.traffic.summarize(nil)
	syncLog(s)
	s.traffic.summarize(nil)
	syncLog(s)
	raw := log.lineLog.raw()
	if node := parse(t, raw, "node"); len(node) != 1 || node[0]["toNode"] != float64(5) {
		t.Fatalf("node lines %v, want the failed one written again", node)
	}
	if relay := parse(t, raw, "relay"); len(relay) != 1 || relay[0]["linesDropped"] != float64(2) {
		t.Fatalf("relay lines %v, want one counting the 2 failed writes", relay)
	}
}

// A final summary line the log fails to take is written again before Close returns.
func TestAFinalLineTheLogFailedToTakeIsRetriedBeforeCloseReturns(t *testing.T) {
	id := newID(t)
	lv, _, _ := trafficLive(t, id)
	log := &failingLog{}
	log.srv = lv.s
	lv.s.TrafficLog = log
	lv.exchange(t, lv.uplink(id, true))
	syncLog(lv.s)
	log.mu.Lock()
	log.fail = 1
	log.mu.Unlock()
	lv.s.Close()
	raw := log.lineLog.raw()
	if node := parse(t, raw, "node"); len(node) != 1 || node[0]["toNode"] != float64(1) {
		t.Fatalf("node lines %v, want the failed final one written again", node)
	}
	relay := parse(t, raw, "relay")
	if last := relay[len(relay)-1]; last["linesDropped"] != float64(1) {
		t.Fatalf("last relay line %v, want the failed write counted", last)
	}
}

// Sessions can reach the totals out of end-time order (a stalled uplink holds an older one), and
// that must not refill the line limit twice for the same seconds.
func TestOutOfOrderSessionEndsDoNotRefillTheLineLimit(t *testing.T) {
	start := time.Date(2026, 11, 12, 0, 0, 0, 0, time.UTC)
	tr := &traffic{burst: 2, rate: 1, lines: make(chan logItem, 100)}
	const ends = 20
	for i := range ends {
		at := start
		if i%2 == 0 {
			at = start.Add(10 * time.Second)
		}
		tr.ended(&sessionTally{node: "n0000000", listed: true, answered: true, admitted: start, ended: at})
	}
	// 10 s of end times allow the burst plus one line a second.
	if got := len(tr.lines); got > 2+10 {
		t.Fatalf("%d session lines from %d out-of-order ends over 10 s, want at most 12", got, ends)
	}
}
