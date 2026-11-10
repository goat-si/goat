package relayserver

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// testBudget is the budget of a socket from address ip.
func testBudget(s *Server, ip string) *budget {
	s.mu.Lock()
	defer s.mu.Unlock()
	return &budget{srv: s, src: s.shareLocked(ip)}
}

// testSock is a socket from address ip writing to ws, joined to rm.
func testSock(s *Server, rm *room, role int, sid uint32, ip string, ws wsWriter) *sock {
	k := &sock{srv: s, room: rm, role: role, sid: sid, ip: ip, authed: role == roleNode, budget: testBudget(s, ip)}
	k.out = newOutq(ws, time.Hour, k.budget, role == roleNode)
	if role == roleNode {
		rm.uplink = k
	} else {
		rm.clients[sid] = k
	}
	return k
}

// A full relay ends the sessions of whoever holds the memory, not whoever sends next: clients from
// one source that stop reading fill at most that source's share, and a session in another room,
// from another source, keeps working.
func TestClientsThatStopReadingFillOnlyTheirSourcesShareOfTheQueueBudget(t *testing.T) {
	s := New(DefaultLimits())
	s.MaxQueued = 64 << 20
	const greedy = "198.51.100.7"
	chunk := make([]byte, 64<<10)
	for range 2 {
		rm := &room{srv: s, clients: map[uint32]*sock{}}
		testSock(s, rm, roleNode, 0, greedy, stalled(t))
		for sid := uint32(1); sid <= 31; sid++ {
			c := testSock(s, rm, roleClient, sid, greedy, stalled(t))
			rm.mu.Lock()
			for range (SocketWindow - RelayHeadroom) / len(chunk) {
				if c.closed {
					break
				}
				rm.toClient(c, chunk)
			}
			rm.mu.Unlock()
		}
	}
	other := &room{srv: s, clients: map[uint32]*sock{}}
	testSock(s, other, roleNode, 0, "203.0.113.1", stalled(t))
	honest := testSock(s, other, roleClient, 1, "203.0.113.2", stalled(t))
	other.mu.Lock()
	other.onClientData(honest, make([]byte, 1<<10))
	other.mu.Unlock()
	if honest.closed {
		t.Fatalf("a session from another source ended once one source filled the relay (%d bytes queued)", s.Queued())
	}
}

// A full relay costs the sources that hold its memory: with the total filled by other sources'
// stalled queues, an honest uplink's ping is still read, and data from its node to its own session
// is still queued, at the expense of the largest holder.
func TestAFullRelayCostsTheSourcesHoldingItNotAnHonestUplink(t *testing.T) {
	s := New(DefaultLimits())
	clk := clocked(s)
	s.MaxQueued = 4 << 20
	s.MaxQueuedPerSource = 1 << 20
	for i := range 4 {
		ip := fmt.Sprintf("198.51.100.%d", i+1)
		rm := &room{srv: s, clients: map[uint32]*sock{}}
		testSock(s, rm, roleNode, 0, ip, stalled(t))
		c := testSock(s, rm, roleClient, 1, ip, stalled(t))
		rm.mu.Lock()
		// Small frames, until the source's share or the total refuses one.
		for !c.closed {
			rm.toClient(c, make([]byte, 256))
		}
		rm.mu.Unlock()
	}
	if q := s.Queued(); q < s.maxQueued()-1024 {
		t.Fatalf("setup: %d bytes queued, want the total of %d about full", q, s.maxQueued())
	}
	clk.at = clk.at.Add(5 * time.Second)
	honest := &room{srv: s, clients: map[uint32]*sock{}}
	up := testSock(s, honest, roleNode, 0, "203.0.113.1", stalled(t))
	c := testSock(s, honest, roleClient, 1, "203.0.113.2", stalled(t))
	if _, err := readMessage(strings.NewReader("ping"), MessageMax, up.budget); err != nil {
		t.Fatalf("an honest uplink's ping on a full relay: %v", err)
	}
	honest.mu.Lock()
	honest.onUplinkFrame(up, wire.Frame{Type: wire.FrameData, SID: 1, Payload: make([]byte, 1<<10)}.Encode())
	honest.mu.Unlock()
	if up.closed || c.closed {
		t.Fatalf("on a full relay the honest uplink closed %v, its session closed %v", up.closed, c.closed)
	}
}

// closableWS is a client that stopped reading: a write blocks until the socket is closed, as a
// real one does once the kernel buffers are full. started tells each write that began.
type closableWS struct {
	started chan struct{}
	gone    chan struct{}
	once    sync.Once
}

func (w *closableWS) Write(ctx context.Context, _ websocket.MessageType, _ []byte) error {
	w.started <- struct{}{}
	select {
	case <-w.gone:
		return errors.New("closed")
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (w *closableWS) Close(websocket.StatusCode, string) error { return w.CloseNow() }
func (w *closableWS) CloseNow() error {
	w.once.Do(func() { close(w.gone) })
	return nil
}

// The memory a full relay holds can sit in messages being written to clients that stopped
// reading, one per queue, with nothing queued behind them. That memory comes back only when the
// write fails, so the offer that finds the relay full is refused (its session ends 4408), but the
// stalled queues are ended without waiting, and once their writes fail the next offer fits.
func TestAFullRelayEndsQueuesStalledInAWriteAndTheNextOfferFits(t *testing.T) {
	s := New(DefaultLimits())
	clk := clocked(s)
	const size = 300 << 10
	item := allocSize(size) + itemOverhead
	s.MaxQueued = 9*item + 512
	s.MaxQueuedPerSource = 1 << 20
	var stuck []*sock
	for i := range 3 {
		ip := fmt.Sprintf("198.51.100.%d", i+1)
		rm := &room{srv: s, clients: map[uint32]*sock{}}
		testSock(s, rm, roleNode, 0, ip, stalled(t))
		for sid := uint32(1); sid <= 3; sid++ {
			ws := &closableWS{started: make(chan struct{}, 1), gone: make(chan struct{})}
			c := testSock(s, rm, roleClient, sid, ip, ws)
			rm.mu.Lock()
			rm.toClient(c, make([]byte, size))
			rm.mu.Unlock()
			<-ws.started
			stuck = append(stuck, c)
		}
	}
	if q := s.Queued(); q != int64(9*item) {
		t.Fatalf("setup: %d bytes queued, want %d in stalled writes", q, 9*item)
	}
	clk.at = clk.at.Add(5 * time.Second)
	honest := &room{srv: s, clients: map[uint32]*sock{}}
	up := testSock(s, honest, roleNode, 0, "203.0.113.1", stalled(t))
	first := testSock(s, honest, roleClient, 1, "203.0.113.2", stalled(t))
	honest.mu.Lock()
	honest.toClient(first, make([]byte, 1<<10))
	honest.mu.Unlock()
	// Ended sockets close in the background; once one has, the eviction may stop early.
	ended := 0
	for _, c := range stuck {
		if isDone(c.out) {
			c.out.wait()
			ended++
		}
	}
	if ended == 0 {
		t.Fatal("a full relay ended none of the queues stalled in a write")
	}
	second := testSock(s, honest, roleClient, 2, "203.0.113.2", stalled(t))
	honest.mu.Lock()
	honest.toClient(second, make([]byte, 1<<10))
	honest.mu.Unlock()
	if second.closed || up.closed {
		t.Fatalf("after the stalled writes failed, the next session closed %v, the uplink %v", second.closed, up.closed)
	}
}

// testClock is a relay clock a test moves by hand.
type testClock struct{ at time.Time }

func (c *testClock) now() time.Time { return c.at }

func clocked(s *Server) *testClock {
	c := &testClock{at: time.Unix(1_000_000, 0)}
	s.clock = c.now
	return c
}

// steppingWS is a client that reads when the test says so: started tells each write that began,
// and a send on proceed finishes it. Seeing write k+1 start shows write k's completion was recorded.
type steppingWS struct {
	stalledWS
	started, proceed chan struct{}
}

func stepping(t *testing.T) *steppingWS {
	ws := &steppingWS{stalledWS: stalledWS{release: make(chan struct{})}, started: make(chan struct{}), proceed: make(chan struct{})}
	t.Cleanup(func() { close(ws.release) })
	return ws
}

func (w *steppingWS) Write(ctx context.Context, _ websocket.MessageType, _ []byte) error {
	select {
	case w.started <- struct{}{}:
	case <-w.release:
		return nil
	case <-w.closed():
		return errors.New("closed")
	}
	select {
	case <-w.proceed:
		return nil
	case <-w.release:
		return nil
	case <-w.closed():
		return errors.New("closed")
	case <-ctx.Done():
		return ctx.Err()
	}
}

// step lets ws finish one write at the clock's time and waits until the next one starts.
func step(ws *steppingWS) {
	ws.proceed <- struct{}{}
	<-ws.started
}

func isDone(q *outq) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.done
}

// fill queues size bytes to c in 64 KiB messages.
func fill(rm *room, c *sock, size int) {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	for sent := 0; sent < size && !c.closed; sent += 64 << 10 {
		rm.toClient(c, make([]byte, 64<<10))
	}
}

// A full relay ends the queue that has gone longest without a finished write, not the largest one:
// an honest bulk transfer that is draining outlasts smaller queues of other sources whose clients
// stopped reading, and its room's other session and uplink stay open.
func TestAFullRelayEndsStalledQueuesBeforeADrainingOne(t *testing.T) {
	s := New(DefaultLimits())
	clk := clocked(s)
	for i := range 3 {
		ip := fmt.Sprintf("198.51.100.%d", i+1)
		rm := &room{srv: s, clients: map[uint32]*sock{}}
		testSock(s, rm, roleNode, 0, ip, stalled(t))
		fill(rm, testSock(s, rm, roleClient, 1, ip, stalled(t)), 512<<10)
	}
	honest := &room{srv: s, clients: map[uint32]*sock{}}
	up := testSock(s, honest, roleNode, 0, "203.0.113.1", stalled(t))
	ws := stepping(t)
	bulk := testSock(s, honest, roleClient, 1, "203.0.113.2", ws)
	other := testSock(s, honest, roleClient, 2, "203.0.113.3", stepping(t))
	fill(honest, bulk, 1<<20)
	<-ws.started
	clk.at = clk.at.Add(5 * time.Second)
	step(ws)
	s.MaxQueued = int(s.Queued()) + 1024
	late := &room{srv: s, clients: map[uint32]*sock{}}
	testSock(s, late, roleNode, 0, "192.0.2.9", stalled(t))
	c := testSock(s, late, roleClient, 1, "192.0.2.9", stepping(t))
	fill(late, c, 64<<10)
	if isDone(bulk.out) || bulk.closed || other.closed || isDone(up.out) || c.closed {
		t.Fatalf("on a full relay the draining bulk queue ended %v (session closed %v), the other session closed %v, the uplink ended %v, the new session closed %v",
			isDone(bulk.out), bulk.closed, other.closed, isDone(up.out), c.closed)
	}
}

// Machines behind one address share its part of the budget. When stalled sockets of that address
// hold it, a session of the same address whose client reads still gets its data: the stalled
// queue ends instead.
func TestAFullSourceShareEndsItsStalledQueueBeforeOneThatReads(t *testing.T) {
	s := New(DefaultLimits())
	clk := clocked(s)
	const nat = "198.51.100.1"
	rm := &room{srv: s, clients: map[uint32]*sock{}}
	testSock(s, rm, roleNode, 0, "203.0.113.1", stalled(t))
	stuck := testSock(s, rm, roleClient, 1, nat, stalled(t))
	fill(rm, stuck, 960<<10)
	ws := stepping(t)
	reading := testSock(s, rm, roleClient, 2, nat, ws)
	fill(rm, reading, 128<<10)
	<-ws.started
	clk.at = clk.at.Add(5 * time.Second)
	step(ws)
	s.mu.Lock()
	held := s.shares[nat].held.Load()
	s.mu.Unlock()
	s.MaxQueuedPerSource = int(held) + 1024
	fill(rm, reading, 64<<10)
	if reading.closed || isDone(reading.out) {
		t.Fatal("a session that reads ended because a stalled socket of its address held the address's share")
	}
	if !isDone(stuck.out) {
		t.Fatal("the stalled queue holding the share kept it")
	}
}

// Every message up to 96 KiB is read without a charge to the shared large-read pool, also when
// that pool is full.
func TestAMessageOfUpTo96KiBIsReadWithAFullLargeReadPool(t *testing.T) {
	s := New(DefaultLimits())
	s.reading.Store(s.maxReading())
	for _, size := range []int{73 << 10, 96 << 10} {
		data, err := readMessage(bytes.NewReader(make([]byte, size)), MessageMax, testBudget(s, "192.0.2.1"))
		if err != nil || len(data) != size {
			t.Fatalf("a %d-byte message with the pool full: %d bytes, %v", size, len(data), err)
		}
	}
}

// stalled is a socket of its own that stopped reading, released when the test ends.
func stalled(t *testing.T) *stalledWS {
	ws := &stalledWS{release: make(chan struct{})}
	t.Cleanup(func() { close(ws.release) })
	return ws
}
