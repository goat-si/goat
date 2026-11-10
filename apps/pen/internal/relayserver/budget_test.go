package relayserver_test

import (
	"context"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// Every socket may queue up to its window, and a relay allows thousands of sockets, so clients that
// stop reading could together hold more than the process may use. One server-wide budget caps what
// all queues hold: data that would pass it ends its session 4408 instead of queueing.
func TestQueuedBytesAcrossSlowReadersStayWithinTheServerBudget(t *testing.T) {
	const budget = 4 << 20
	rs := relaytest.NewUnstarted()
	rs.Relay.MaxQueued = budget
	rs.Start()
	t.Cleanup(rs.Close)
	n := ready(t, rs, nodeOpts{})
	chunk := make([]byte, 64<<10)
	var sids []uint32
	for range 3 {
		stuckClient(t, rs, n.nodeID)
		sids = append(sids, n.expect(t, wire.FrameOpen, 0).SID)
	}
	// 3 MiB toward each stuck client: under its own 4 MiB window, 9 MiB in all.
	for _, sid := range sids {
		for range (3 << 20) / len(chunk) {
			n.frameOut(wire.FrameData, sid, chunk)
		}
	}
	// The relay handles an uplink's messages in order, so its pong means every frame above was handled.
	n.sendText("ping")
	if got := <-n.texts; got != "pong" {
		t.Fatalf("uplink got %q, want pong", got)
	}
	if q := rs.Relay.Queued(); q > budget {
		t.Fatalf("the relay holds %d queued bytes, past its budget of %d", q, budget)
	}
	// Whether a session also had to end depends on how much the kernel's socket buffers absorbed;
	// budget_internal_test.go checks that without them.
	_, _ = context.Background, time.Second
}
