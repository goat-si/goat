package relayserver

import (
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
	k.out = newOutq(ws, time.Hour, k.budget)
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
// reading, one per queue, with nothing queued behind them. Ending such a queue must give that
// memory back before the honest message is refused.
func TestAFullRelayEndsAQueueWhoseMemoryIsInAStalledWrite(t *testing.T) {
	s := New(DefaultLimits())
	const size = 300 << 10
	item := allocSize(size) + itemOverhead
	s.MaxQueued = 9*item + 512
	s.MaxQueuedPerSource = 1 << 20
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
		}
	}
	if q := s.Queued(); q != int64(9*item) {
		t.Fatalf("setup: %d bytes queued, want %d in stalled writes", q, 9*item)
	}
	honest := &room{srv: s, clients: map[uint32]*sock{}}
	open := &closableWS{started: make(chan struct{}, 8), gone: make(chan struct{})}
	up := testSock(s, honest, roleNode, 0, "203.0.113.1", open)
	c := testSock(s, honest, roleClient, 1, "203.0.113.2", open)
	honest.mu.Lock()
	honest.onUplinkFrame(up, wire.Frame{Type: wire.FrameData, SID: 1, Payload: make([]byte, 1<<10)}.Encode())
	honest.mu.Unlock()
	if up.closed || c.closed {
		t.Fatalf("on a relay full of stalled writes the honest uplink closed %v, its session closed %v", up.closed, c.closed)
	}
}

// stalled is a socket of its own that stopped reading, released when the test ends.
func stalled(t *testing.T) *stalledWS {
	ws := &stalledWS{release: make(chan struct{})}
	t.Cleanup(func() { close(ws.release) })
	return ws
}
