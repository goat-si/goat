package relayserver

import (
	"fmt"
	"testing"
)

// The server-wide queue budget, without kernel socket buffers in the way (they absorb a different
// amount on every OS): clients that never read, each under its own window, lose their sessions once
// the budget is spent (refused 4408, or their queue ended for a smaller holder), and what stays
// queued never passes it.
func TestSessionDataPastTheServerQueueBudgetEndsItsSession(t *testing.T) {
	const budget = 4 << 20
	s := New(DefaultLimits())
	s.MaxQueued = budget
	ws := &stalledWS{release: make(chan struct{})}
	defer close(ws.release)
	rm := &room{srv: s, clients: map[uint32]*sock{}}
	var clients []*sock
	for sid := uint32(1); sid <= 3; sid++ {
		// Each from its own address: this test is about the server-wide budget.
		c := testSock(s, rm, roleClient, sid, fmt.Sprintf("192.0.2.%d", sid), ws)
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
		c.out.mu.Lock()
		aborted := c.out.done
		c.out.mu.Unlock()
		if c.closed || aborted {
			ended++
		}
	}
	if ended == 0 {
		t.Fatal("no session ended once the budget was spent")
	}
}
