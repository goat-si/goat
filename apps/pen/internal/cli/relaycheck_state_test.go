package cli

import (
	"bytes"
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/state"
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
// that has not gone yet) gets no word when the relay takes its own uplink. Here the relay handles
// the new uplink's answer only once the check's client has reached the earlier uplink; the check
// must still end with its session on its own uplink, by opening it again.
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
	releaseAnswer := rs.HoldNextUplinkMessage()
	defer releaseAnswer()
	go func() {
		if rs.NextClientMessage(ctx, id.NodeID()) == nil {
			releaseAnswer()
		}
	}()
	var out, errOut bytes.Buffer
	if code := RunRelay([]string{"check", "--timeout", "10s", rs.URL}, &out, &errOut); code != 0 {
		t.Fatalf("check while an earlier uplink of its node was still at the relay: exit %d\n%s%s", code, out.String(), errOut.String())
	}
}

// --timeout bounds every lock the check waits for: another process holding the check node's state
// lock (say, a check creating the node's keys) makes the check give up, not hang.
func TestCheckIdentityGivesUpWhenTheCheckNodesStateLockIsHeld(t *testing.T) {
	t.Setenv("PEN_HOME", t.TempDir())
	dir, err := state.Dir()
	if err != nil {
		t.Fatal(err)
	}
	st, err := state.OpenDir(filepath.Join(dir, "relay-check"))
	if err != nil {
		t.Fatal(err)
	}
	unlock, err := st.Lock()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if _, _, err := checkIdentity(ctx); err == nil {
		t.Fatal("checkIdentity got the check node while its state lock was held")
	}
	// The abandoned wait goes on in the background; taking the node once more waits for it.
	unlock()
	_, release, err := checkIdentity(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	release()
}
