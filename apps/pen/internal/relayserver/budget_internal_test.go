package relayserver

import (
	"testing"
	"time"
)

// The server-wide queue budget, without kernel socket buffers in the way (they absorb a different
// amount on every OS): clients that never read, each under its own window, end 4408 once the
// budget is spent, and what stays queued never passes it.
func TestSessionDataPastTheServerQueueBudgetEndsItsSession(t *testing.T) {
	const budget = 4 << 20
	s := New(DefaultLimits())
	s.MaxQueued = budget
	ws := &stalledWS{release: make(chan struct{})}
	defer close(ws.release)
	rm := &room{srv: s, clients: map[uint32]*sock{}}
	var clients []*sock
	for sid := uint32(1); sid <= 3; sid++ {
		c := &sock{srv: s, room: rm, role: roleClient, sid: sid, out: newOutq(ws, time.Hour, &s.queued)}
		rm.clients[sid] = c
		clients = append(clients, c)
	}
	chunk := make([]byte, 64<<10)
	for _, c := range clients {
		for range (3 << 20) / len(chunk) {
			rm.toClient(c, chunk)
		}
	}
	if q := s.Queued(); q > budget {
		t.Fatalf("%d bytes queued, past the budget of %d", q, budget)
	}
	ended := 0
	for _, c := range clients {
		if c.closed {
			ended++
		}
	}
	if ended == 0 {
		t.Fatal("no session ended once the budget was spent")
	}
}
