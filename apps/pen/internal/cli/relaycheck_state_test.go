package cli

import (
	"bytes"
	"sync"
	"testing"

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
