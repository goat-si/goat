package cli

import (
	"bytes"
	"context"
	"sync"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
)

// Relays keep a little state per node id (the Go relay its next session id, the Worker a Durable
// Object), so repeated checks from one machine reuse one check identity instead of adding a node
// per run.
func TestRepeatedRelayChecksUseOneNodeID(t *testing.T) {
	t.Setenv("PEN_HOME", t.TempDir())
	rs := relaytest.NewUnstarted()
	var mu sync.Mutex
	seen := map[string]bool{}
	hook := rs.Relay.Hooks.OnUplink
	rs.Relay.Hooks.OnUplink = func(nodeID string) {
		mu.Lock()
		seen[nodeID] = true
		mu.Unlock()
		hook(nodeID)
	}
	rs.Start()
	defer rs.Close()
	for range 2 {
		var out, errOut bytes.Buffer
		if code := RunRelay([]string{"check", rs.URL}, &out, &errOut); code != 0 {
			t.Fatalf("check: exit %d\n%s%s", code, out.String(), errOut.String())
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 1 {
		t.Fatalf("two checks uplinked %d node ids, want one", len(seen))
	}
}

// A check that finds an earlier uplink of the check node still at the relay (a check before it
// that has not gone yet) must not open its session there: it waits until the relay has taken its
// own uplink, here slowed down, and its session reaches it.
func TestRelayCheckOpensItsSessionOnlyOnceTheRelayHasTakenItsUplink(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	t.Setenv("PEN_HOME", t.TempDir())
	rs := relaytest.New()
	defer rs.Close()
	id, release, err := checkIdentity(ctx)
	if err != nil {
		t.Fatal(err)
	}
	release()
	earlier := relay.NewUplink(rs.URL, id)
	go earlier.Run(ctx)
	if err := rs.WaitOnline(ctx, id.NodeID()); err != nil {
		t.Fatal(err)
	}
	rs.DelayNextNodeMessage(500 * time.Millisecond)
	var out, errOut bytes.Buffer
	if code := RunRelay([]string{"check", "--timeout", "10s", rs.URL}, &out, &errOut); code != 0 {
		t.Fatalf("check while an earlier uplink of its node was still at the relay: exit %d\n%s%s", code, out.String(), errOut.String())
	}
}
