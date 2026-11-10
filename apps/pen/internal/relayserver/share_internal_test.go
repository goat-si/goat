package relayserver

import (
	"testing"
	"time"
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
	ws := &stalledWS{release: make(chan struct{})}
	defer close(ws.release)
	const greedy = "198.51.100.7"
	chunk := make([]byte, 64<<10)
	for range 2 {
		rm := &room{srv: s, clients: map[uint32]*sock{}}
		testSock(s, rm, roleNode, 0, greedy, ws)
		for sid := uint32(1); sid <= 31; sid++ {
			c := testSock(s, rm, roleClient, sid, greedy, ws)
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
	testSock(s, other, roleNode, 0, "203.0.113.1", ws)
	honest := testSock(s, other, roleClient, 1, "203.0.113.2", ws)
	other.mu.Lock()
	other.onClientData(honest, make([]byte, 1<<10))
	other.mu.Unlock()
	if honest.closed {
		t.Fatalf("a session from another source ended once one source filled the relay (%d bytes queued)", s.Queued())
	}
}
