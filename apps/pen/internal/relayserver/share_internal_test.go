package relayserver

import (
	"bytes"
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

// timerNever is an idle timer that does not fire during a test.
func timerNever() *time.Timer { return time.NewTimer(time.Hour) }
