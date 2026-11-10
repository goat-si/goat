package relayserver

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Bar (i): the counted queue and large-read memory never pass their totals, not even for a moment,
// while sources whose shares together exceed the total charge, read and give back at once.
func TestCountedMemoryNeverPassesItsTotalsUnderConcurrentOffersAndReads(t *testing.T) {
	s := New(DefaultLimits())
	s.MaxQueued = 1 << 20
	s.MaxQueuedPerSource = 256 << 10 // 16 sources could hold 4 MiB
	s.MaxReading = 1 << 20
	var over atomic.Int64
	check := func() {
		if s.Queued() > s.maxQueued() || s.Reading() > s.maxReading() {
			over.Add(1)
		}
	}
	for round := range 20 {
		var filled, done sync.WaitGroup
		release := make(chan struct{})
		for g := range 16 {
			filled.Add(1)
			done.Add(1)
			go func() {
				defer done.Done()
				b := testBudget(s, fmt.Sprintf("198.51.100.%d", g+1))
				var held []int
				for i := 0; ; i++ {
					n := 1<<10 + (i*7919+g*104729+round)%(32<<10)
					if !b.try(n) {
						break
					}
					held = append(held, n)
					check()
				}
				// Session frame reservations on a queue of its own while the budget is full.
				q := newOutq(stalled(t), time.Hour, b)
				for q.reserve(sessionFrameCost) {
					check()
				}
				q.pushReserved(make([]byte, 7), sessionFrameCost)
				check()
				// A read past the allowance while the queues are full.
				if data, err := readMessage(bytes.NewReader(make([]byte, 200<<10)), MessageMax, b); err == nil {
					check()
					b.countRead(-readCharge(cap(data)))
				}
				filled.Done()
				<-release
				for _, h := range held {
					b.release(h)
				}
				// Closing the socket fails the write in flight, which gives its charge back.
				q.mu.Lock()
				q.dropLocked()
				q.mu.Unlock()
				q.ws.CloseNow()
				q.wait()
			}()
		}
		filled.Wait()
		check()
		if q := s.Queued(); q < s.maxQueued()-(64<<10) {
			t.Fatalf("setup: only %d of %d queued; the sources did not press against the total", q, s.maxQueued())
		}
		close(release)
		done.Wait()
	}
	if n := over.Load(); n > 0 {
		t.Fatalf("the counted memory passed its total %d times", n)
	}
	if s.Queued() != 0 || s.Reading() != 0 {
		t.Fatalf("%d queued and %d read bytes still counted after everything was given back", s.Queued(), s.Reading())
	}
}

// Bar (ii): everything one source can do toward others' sockets (stalled clients filling its own
// share through its two nodes, pending sessions toward another's node flooding empty and maximum
// messages) ends no session or uplink of another source and refuses none of their data, while the
// other sources together hold less than the total minus one share.
func TestOneSourceCannotEndOrRefuseAnotherSourcesSessions(t *testing.T) {
	s := New(DefaultLimits())
	s.MaxQueued = 48 << 20
	const attacker = "198.51.100.66"
	for range 2 {
		rm := &room{srv: s, clients: map[uint32]*sock{}}
		testSock(s, rm, roleNode, 0, attacker, stalled(t))
		for sid := uint32(1); sid <= 31; sid++ {
			fill(rm, testSock(s, rm, roleClient, sid, attacker, stalled(t)), SocketWindow)
		}
	}
	victim := &room{srv: s, clients: map[uint32]*sock{}}
	up := testSock(s, victim, roleNode, 0, "192.0.2.1", stalled(t))
	friend := testSock(s, victim, roleClient, 1, "203.0.113.2", stalled(t))
	var floods []*sock
	victim.mu.Lock()
	for sid := uint32(10); sid < 18; sid++ {
		c := testSock(s, victim, roleClient, sid, attacker, stalled(t))
		c.pending = true
		victim.onClientData(c, make([]byte, FirstMessageMax))
		for range 100 {
			victim.onClientData(c, nil)
		}
		floods = append(floods, c)
	}
	big := testSock(s, victim, roleClient, 20, attacker, stalled(t))
	big.pending = true
	victim.onClientData(big, make([]byte, MessageMax))
	for range 16 {
		victim.onClientData(friend, make([]byte, 64<<10))
	}
	victim.toClient(friend, make([]byte, 64<<10))
	victim.mu.Unlock()
	if friend.closed || up.closed {
		t.Fatalf("one source's traffic ended another source's session %v or uplink %v (%d bytes queued)", friend.closed, up.closed, s.Queued())
	}
	for _, c := range append(floods, big) {
		if !c.closed {
			t.Fatalf("pending session %d sent past its one first message and stayed open", c.sid)
		}
	}
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

// Bar (iii): a full relay ends only the session whose data does not fit, never an uplink, and
// still reads and answers the uplink's ping (control messages are not charged).
func TestAFullRelayNeverEndsAnUplinkAndAnswersItsPing(t *testing.T) {
	s := New(DefaultLimits())
	s.MaxQueued = 4 << 20
	s.MaxQueuedPerSource = 1 << 20
	s.MaxReading = 1 << 20
	for i := range 6 {
		ip := fmt.Sprintf("198.51.100.%d", i+1)
		rm := &room{srv: s, clients: map[uint32]*sock{}}
		testSock(s, rm, roleNode, 0, ip, stalled(t))
		fill(rm, testSock(s, rm, roleClient, 1, ip, stalled(t)), 1<<20)
	}
	s.reading.Store(s.maxReading())
	if s.Queued() < s.maxQueued()-(64<<10) {
		t.Fatalf("setup: %d of %d queued", s.Queued(), s.maxQueued())
	}
	rec := &recordingWS{texts: make(chan string, 4)}
	rm := &room{srv: s, clients: map[uint32]*sock{}}
	up := testSock(s, rm, roleNode, 0, "203.0.113.1", rec)
	up.idle = timerNever()
	toNode := testSock(s, rm, roleClient, 1, "203.0.113.2", stalled(t))
	toClient := testSock(s, rm, roleClient, 2, "203.0.113.3", stalled(t))
	if _, err := readMessage(io.LimitReader(bytes.NewReader([]byte("ping")), 5), MessageMax, up.budget); err != nil {
		t.Fatalf("a full relay did not read the uplink's ping: %v", err)
	}
	rm.mu.Lock()
	rm.onClientData(toNode, make([]byte, 2<<20>>2))
	rm.toClient(toClient, make([]byte, 2<<20>>2))
	rm.onText(up, "ping")
	rm.mu.Unlock()
	if got := <-rec.texts; got != "pong" || up.closed {
		t.Fatalf("on a full relay the uplink got %q and was closed %v", got, up.closed)
	}
	if !toNode.closed || !toClient.closed {
		t.Fatalf("data that did not fit left its sessions open (%v, %v)", toNode.closed, toClient.closed)
	}
}

// A session the node has not answered sends one message of at most 4096 bytes: a second, even an
// empty one, ends it. Empty messages from many pending sessions therefore cannot fill a slow
// uplink's queue, and an established session's 64 KiB still fits.
func TestAPendingSessionSendsOneMessageThenEmptyFloodsEndIt(t *testing.T) {
	s := New(DefaultLimits())
	rm := &room{srv: s, clients: map[uint32]*sock{}}
	up := testSock(s, rm, roleNode, 0, "192.0.2.1", stalled(t))
	established := testSock(s, rm, roleClient, 1, "192.0.2.2", stalled(t))
	var pending []*sock
	rm.mu.Lock()
	for sid := uint32(10); sid < 18; sid++ {
		c := testSock(s, rm, roleClient, sid, "198.51.100.9", stalled(t))
		c.pending = true
		rm.onClientData(c, nil)
		if c.closed {
			rm.mu.Unlock()
			t.Fatal("a pending session's first message ended it")
		}
		for range 30000 {
			if c.closed {
				break
			}
			rm.onClientData(c, nil)
		}
		pending = append(pending, c)
	}
	oversized := testSock(s, rm, roleClient, 30, "198.51.100.9", stalled(t))
	oversized.pending = true
	rm.onClientData(oversized, make([]byte, FirstMessageMax+1))
	rm.onClientData(established, make([]byte, 64<<10))
	rm.mu.Unlock()
	for _, c := range pending {
		if !c.closed {
			t.Fatalf("pending session %d stayed open after a second message", c.sid)
		}
	}
	if !oversized.closed {
		t.Fatal("a pending session's first message over 4096 bytes left it open")
	}
	if established.closed || up.closed {
		t.Fatalf("empty floods from pending sessions ended the established session %v or the uplink %v", established.closed, up.closed)
	}
}

// unadmitted is a client socket from ip that has not been accepted yet.
func unadmitted(t *testing.T, s *Server, rm *room, ip string) *sock {
	k := &sock{srv: s, room: rm, role: roleClient, ip: ip, budget: testBudget(s, ip)}
	k.out = newOutq(stalled(t), time.Hour, k.budget)
	return k
}

// M1: one source opening pending sessions to a node ends only its own, past two; past eight in
// all, the source holding the most loses its oldest. An honest pending session stays.
func TestOneSourcesPendingSessionsDoNotDisplaceAnothersPendingSession(t *testing.T) {
	s := New(DefaultLimits())
	rm := &room{srv: s, clients: map[uint32]*sock{}}
	testSock(s, rm, roleNode, 0, "192.0.2.1", stalled(t))
	honest := unadmitted(t, s, rm, "203.0.113.5")
	if !rm.acceptClient(honest) {
		t.Fatal("setup: the honest client was refused")
	}
	for i := range 4 {
		for range 8 {
			rm.acceptClient(unadmitted(t, s, rm, fmt.Sprintf("198.51.100.%d", i+1)))
		}
	}
	rm.mu.Lock()
	defer rm.mu.Unlock()
	if honest.closed {
		t.Fatal("other sources' pending sessions ended the honest pending session")
	}
	per := map[string]int{}
	for _, c := range rm.clients {
		if c.pending {
			per[c.ip]++
		}
	}
	for ip, n := range per {
		if n > PendingPerSource {
			t.Fatalf("%s holds %d pending sessions, more than %d", ip, n, PendingPerSource)
		}
	}
}

// M2: clients of another source opening and closing sessions in a loop against a node whose
// uplink does not take writes never end the uplink or an unrelated session: each session's OPEN
// and CLOSE are reserved when it is admitted, and once the room is gone new clients are refused.
func TestSessionChurnAgainstAStalledUplinkRefusesNewClientsAndEndsNothing(t *testing.T) {
	s := New(DefaultLimits())
	rm := &room{srv: s, clients: map[uint32]*sock{}}
	up := testSock(s, rm, roleNode, 0, "192.0.2.1", stalled(t))
	established := testSock(s, rm, roleClient, 1, "203.0.113.2", stalled(t))
	refused := 0
	for i := range 40000 {
		c := unadmitted(t, s, rm, fmt.Sprintf("198.51.100.%d", i%4+1))
		if !rm.acceptClient(c) {
			refused++
			continue
		}
		rm.peerGone(c, 1000)
	}
	if up.closed || isDone(up.out) || established.closed {
		t.Fatalf("session churn ended the uplink (closed %v, queue ended %v) or the established session (%v)", up.closed, isDone(up.out), established.closed)
	}
	if refused == 0 {
		t.Fatal("no client was refused once the uplink's room for session frames was used")
	}
	rm.mu.Lock()
	rm.onClientData(established, make([]byte, 64<<10))
	rm.mu.Unlock()
	if established.closed {
		t.Fatal("session frames took the established session's room in the uplink window")
	}
}
