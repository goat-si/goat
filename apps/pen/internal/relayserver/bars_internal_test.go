package relayserver

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// Bar (i): whatever many sources do, the memory the relay counts for queued data never passes the
// total it was given.
func TestQueuedMemoryNeverPassesTheTotal(t *testing.T) {
	s := New(DefaultLimits())
	clk := clocked(s)
	s.MaxQueued = 2 << 20
	s.MaxQueuedPerSource = 512 << 10
	for round := range 3 {
		for i := range 8 {
			ip := fmt.Sprintf("198.51.100.%d", i+1)
			rm := &room{srv: s, clients: map[uint32]*sock{}}
			testSock(s, rm, roleNode, 0, ip, stalled(t))
			c := testSock(s, rm, roleClient, uint32(round+1), ip, stalled(t))
			for range 12 {
				rm.mu.Lock()
				rm.toClient(c, make([]byte, 64<<10))
				rm.mu.Unlock()
				if q := s.Queued(); q > s.maxQueued() {
					t.Fatalf("%d bytes queued past the total of %d", q, s.maxQueued())
				}
			}
		}
		clk.at = clk.at.Add(5 * time.Second)
	}
}

// Bar (ii) and the uplink path: data a client of another source sends toward an uplink whose
// address holds nearly its whole share, before and after the node answered, ends only that
// client's session; no queue of the uplink's address ends.
func TestDataFromAnotherSourceNeverEndsTheDestinationSourcesQueues(t *testing.T) {
	s := New(DefaultLimits())
	clk := clocked(s)
	const office = "192.0.2.1"
	s.MaxQueuedPerSource = 1 << 20
	rm := &room{srv: s, clients: map[uint32]*sock{}}
	up := testSock(s, rm, roleNode, 0, office, stalled(t))
	var mine []*sock
	for sid := uint32(1); sid <= 3; sid++ {
		c := testSock(s, rm, roleClient, sid, office, stalled(t))
		fill(rm, c, 256<<10)
		mine = append(mine, c)
	}
	clk.at = clk.at.Add(5 * time.Second)
	pending := testSock(s, rm, roleClient, 10, "203.0.113.9", stalled(t))
	pending.pending = true
	answered := testSock(s, rm, roleClient, 11, "203.0.113.9", stalled(t))
	rm.mu.Lock()
	rm.onClientData(pending, make([]byte, 4000))
	for range 8 {
		rm.onClientData(answered, make([]byte, 64<<10))
	}
	rm.mu.Unlock()
	if up.closed || isDone(up.out) {
		t.Fatal("another source's data ended the uplink")
	}
	for _, c := range mine {
		if c.closed || isDone(c.out) {
			t.Fatalf("another source's data ended session %d of the uplink's address", c.sid)
		}
	}
	if !answered.closed {
		t.Fatal("setup: the answered session's data fitted; it should have passed the address's share")
	}
}

// Before its node answers, a session may send only its first message toward the uplink, so the
// eight pending sessions a node may have hold little of its address's share.
func TestAPendingSessionSendsAtMostItsFirstMessage(t *testing.T) {
	s := New(DefaultLimits())
	rm := &room{srv: s, clients: map[uint32]*sock{}}
	testSock(s, rm, roleNode, 0, "192.0.2.1", stalled(t))
	c := testSock(s, rm, roleClient, 1, "203.0.113.9", stalled(t))
	c.pending = true
	rm.mu.Lock()
	rm.onClientData(c, make([]byte, FirstMessageMax))
	first := c.closed
	rm.onClientData(c, make([]byte, 1))
	rm.mu.Unlock()
	if first || !c.closed {
		t.Fatalf("a pending session's first message closed it %v; one byte more closed it %v", first, c.closed)
	}
}

// Bar (iii): among stalled queues a client's goes before an uplink's, even a younger one, since
// an uplink takes every session of its node with it.
func TestAFullRelayEndsAStalledClientQueueBeforeAStalledUplink(t *testing.T) {
	s := New(DefaultLimits())
	clk := clocked(s)
	a := &room{srv: s, clients: map[uint32]*sock{}}
	up := testSock(s, a, roleNode, 0, "198.51.100.1", stalled(t))
	for range 8 {
		up.out.offerFrame(1, make([]byte, 64<<10))
	}
	clk.at = clk.at.Add(time.Second)
	b := &room{srv: s, clients: map[uint32]*sock{}}
	testSock(s, b, roleNode, 0, "198.51.100.2", stalled(t))
	c := testSock(s, b, roleClient, 1, "198.51.100.2", stalled(t))
	fill(b, c, 256<<10)
	clk.at = clk.at.Add(10 * time.Second)
	s.MaxQueued = int(s.Queued()) + 1024
	late := &room{srv: s, clients: map[uint32]*sock{}}
	testSock(s, late, roleNode, 0, "192.0.2.9", stalled(t))
	fill(late, testSock(s, late, roleClient, 1, "192.0.2.9", stalled(t)), 64<<10)
	if isDone(up.out) || !isDone(c.out) {
		t.Fatalf("a full relay ended the stalled uplink %v and the stalled client queue %v; want only the client's", isDone(up.out), isDone(c.out))
	}
}

// A draining offer that needs the room of four stalled queues gets it: the relay ends the
// longest stalled first, as many as needed, and leaves a fifth that is not needed.
func TestADrainingOfferEndsAsManyStalledQueuesAsItNeeds(t *testing.T) {
	s := New(DefaultLimits())
	clk := clocked(s)
	var stuck []*sock
	for i := range 5 {
		ip := fmt.Sprintf("198.51.100.%d", i+1)
		rm := &room{srv: s, clients: map[uint32]*sock{}}
		testSock(s, rm, roleNode, 0, ip, stalled(t))
		c := testSock(s, rm, roleClient, 1, ip, stalled(t))
		fill(rm, c, 320<<10) // one 64 KiB message in the write, 256 KiB queued
		stuck = append(stuck, c)
		clk.at = clk.at.Add(time.Second)
	}
	clk.at = clk.at.Add(5 * time.Second)
	s.MaxQueued = int(s.Queued()) + 1024
	honest := &room{srv: s, clients: map[uint32]*sock{}}
	testSock(s, honest, roleNode, 0, "203.0.113.1", stalled(t))
	c := testSock(s, honest, roleClient, 1, "203.0.113.2", stalled(t))
	honest.mu.Lock()
	honest.toClient(c, make([]byte, 4*256<<10-64<<10))
	honest.mu.Unlock()
	if c.closed {
		t.Fatal("a draining offer ended although the stalled queues it could end made room")
	}
	for i, q := range stuck {
		if want := i < 4; isDone(q.out) != want {
			t.Fatalf("stalled queue %d (the %d. longest stalled) ended %v, want %v", i, i+1, isDone(q.out), want)
		}
	}
}

// A queue chosen as stalled that finishes a write before it is ended is draining again: the relay
// leaves it and ends the next stalled one instead.
func TestAQueueThatDrainsAfterItWasChosenIsNotEnded(t *testing.T) {
	s := New(DefaultLimits())
	clk := clocked(s)
	var stuck []*sock
	for i := range 2 {
		ip := fmt.Sprintf("198.51.100.%d", i+1)
		rm := &room{srv: s, clients: map[uint32]*sock{}}
		testSock(s, rm, roleNode, 0, ip, stalled(t))
		c := testSock(s, rm, roleClient, 1, ip, stalled(t))
		fill(rm, c, 320<<10)
		stuck = append(stuck, c)
		clk.at = clk.at.Add(time.Second)
	}
	clk.at = clk.at.Add(5 * time.Second)
	s.beforeEnd = func(q *outq) {
		if q == stuck[0].out {
			q.mu.Lock()
			q.since = clk.at // it finished a write just now
			q.mu.Unlock()
		}
	}
	s.MaxQueued = int(s.Queued()) + 1024
	honest := &room{srv: s, clients: map[uint32]*sock{}}
	testSock(s, honest, roleNode, 0, "203.0.113.1", stalled(t))
	c := testSock(s, honest, roleClient, 1, "203.0.113.2", stalled(t))
	fill(honest, c, 64<<10)
	if isDone(stuck[0].out) || !isDone(stuck[1].out) || c.closed {
		t.Fatalf("the queue that drained ended %v, the stalled one %v, the offer's session %v", isDone(stuck[0].out), isDone(stuck[1].out), c.closed)
	}
}

// blockingCloseWS is a client that stopped reading whose socket takes long to close: CloseNow
// waits for release, then fails the write.
type blockingCloseWS struct {
	entered, release, gone chan struct{}
	once                   sync.Once
}

func (w *blockingCloseWS) Write(ctx context.Context, _ websocket.MessageType, _ []byte) error {
	select {
	case <-w.gone:
		return errors.New("closed")
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (w *blockingCloseWS) Close(websocket.StatusCode, string) error { return w.CloseNow() }
func (w *blockingCloseWS) CloseNow() error {
	w.once.Do(func() {
		close(w.entered)
		<-w.release
		close(w.gone)
	})
	return nil
}

// recordingWS takes every write at once and reports text messages.
type recordingWS struct{ texts chan string }

func (w *recordingWS) Write(_ context.Context, typ websocket.MessageType, p []byte) error {
	if typ == websocket.MessageText {
		w.texts <- string(p)
	}
	return nil
}
func (w *recordingWS) Close(websocket.StatusCode, string) error { return nil }
func (w *recordingWS) CloseNow() error                          { return nil }

// An uplink's ping is answered while an offer for its room ended a stalled queue whose socket is
// slow to close: ending a queue never makes the room wait.
func TestAnUplinksPingIsAnsweredWhileAnEndedSocketIsStillClosing(t *testing.T) {
	s := New(DefaultLimits())
	clk := clocked(s)
	slow := &blockingCloseWS{entered: make(chan struct{}), release: make(chan struct{}), gone: make(chan struct{})}
	far := &room{srv: s, clients: map[uint32]*sock{}}
	testSock(s, far, roleNode, 0, "198.51.100.1", stalled(t))
	fill(far, testSock(s, far, roleClient, 1, "198.51.100.1", slow), 320<<10)
	clk.at = clk.at.Add(5 * time.Second)
	s.MaxQueued = int(s.Queued()) + 1024
	rec := &recordingWS{texts: make(chan string, 4)}
	rm := &room{srv: s, clients: map[uint32]*sock{}}
	up := testSock(s, rm, roleNode, 0, "203.0.113.1", rec)
	up.idle = time.AfterFunc(time.Hour, func() {})
	defer up.idle.Stop()
	c := testSock(s, rm, roleClient, 1, "203.0.113.2", stalled(t))
	pinged := make(chan string)
	go func() {
		<-slow.entered
		rm.mu.Lock()
		rm.onText(up, "ping")
		rm.mu.Unlock()
		pinged <- <-rec.texts
		close(slow.release)
	}()
	fill(rm, c, 128<<10)
	if got := <-pinged; got != "pong" {
		t.Fatalf("the uplink got %q, want pong", got)
	}
	_ = wire.FrameData
}
