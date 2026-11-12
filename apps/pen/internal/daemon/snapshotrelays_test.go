package daemon

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

type relayState struct{ URL, Uplink string }

type relayLine struct {
	Gen     uint64
	Members []struct{ Name string }
	Relays  []relayState
}

// relayWatch follows watch.snapshot and decodes each line's relays; a line without the member fails.
func relayWatch(t *testing.T, n *node) func() relayLine {
	t.Helper()
	h, _ := snapWatch(t, n)
	pending := []map[string]any{h.reply}
	return func() relayLine {
		t.Helper()
		var m map[string]any
		if len(pending) > 0 {
			m, pending = pending[0], pending[1:]
		} else {
			var ok bool
			if m, ok = h.next(t); !ok {
				t.Fatal("snapshot watch ended")
			}
		}
		if _, ok := m["relays"]; !ok {
			t.Fatalf("snapshot line has no relays: %v", m)
		}
		raw, _ := json.Marshal(m)
		var l relayLine
		if err := json.Unmarshal(raw, &l); err != nil {
			t.Fatal(err)
		}
		return l
	}
}

func twoRelayNode(t *testing.T, ctx context.Context) (*node, *relaytest.Server, *relaytest.Server) {
	t.Helper()
	ra, rb := relaytest.New(), relaytest.New()
	t.Cleanup(ra.Close)
	t.Cleanup(rb.Close)
	st := shortDir(t)
	id := identity(t, st, ra.URL, "a")
	if err := st.SaveConfig(state.Config{Relay: ra.URL, Relays: []string{ra.URL, rb.URL}, Name: "a"}); err != nil {
		t.Fatal(err)
	}
	if _, err := mesh.Found(st, id, "a", 1); err != nil {
		t.Fatal(err)
	}
	n := start(t, ctx, ra, st, nil)
	if err := rb.WaitOnline(ctx, n.d.NodeID()); err != nil {
		t.Fatal(err)
	}
	return n, ra, rb
}

// until reads lines, each one generation after the last, until want holds.
func until(t *testing.T, next func() relayLine, last *uint64, want func(relayLine) bool) relayLine {
	t.Helper()
	for {
		l := next()
		if *last != 0 && l.Gen != *last+1 {
			t.Fatalf("generation %d after %d", l.Gen, *last)
		}
		*last = l.Gen
		if want(l) {
			return l
		}
	}
}

func relaysAre(want ...relayState) func(relayLine) bool {
	return func(l relayLine) bool { return reflect.DeepEqual(l.Relays, want) }
}

func TestSnapshotLinesCarryTheRelayListAndEachUplinksStateInOrder(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a, ra, rb := twoRelayNode(t, ctx)
	next := relayWatch(t, a)
	var last uint64
	until(t, next, &last, relaysAre(relayState{ra.URL, "up"}, relayState{rb.URL, "up"}))
	rb.DropUplink(a.d.NodeID())
	until(t, next, &last, relaysAre(relayState{ra.URL, "up"}, relayState{rb.URL, "connecting"}))
	until(t, next, &last, relaysAre(relayState{ra.URL, "up"}, relayState{rb.URL, "up"}))
	if err := Call(a.st, Request{Op: "relays", Relays: []string{ra.URL}}, new(any)); err != nil {
		t.Fatal(err)
	}
	until(t, next, &last, relaysAre(relayState{ra.URL, "up"}))
}

func TestAStateChangeFromARelayNoLongerConfiguredNeverReachesTheSnapshot(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a, ra, rs := twoRelayNode(t, ctx)
	next := relayWatch(t, a)
	var last uint64
	until(t, next, &last, relaysAre(relayState{ra.URL, "up"}, relayState{rs.URL, "up"}))
	a.d.upMu.Lock()
	stale := a.d.slots[1]
	a.d.upMu.Unlock()
	if err := Call(a.st, Request{Op: "relays", Relays: []string{ra.URL}}, new(any)); err != nil {
		t.Fatal(err)
	}
	until(t, next, &last, relaysAre(relayState{ra.URL, "up"}))
	a.d.onUplink(stale, false) // a late callback from the replaced uplink
	joiner(t, ctx, ra, a.invite(t, time.Minute), "b")
	l := until(t, next, &last, func(relayLine) bool { return true })
	if len(l.Members) != 2 || !reflect.DeepEqual(l.Relays, []relayState{{ra.URL, "up"}}) {
		t.Fatalf("the line after the stale callback is %+v; want the join's line with only the configured relay", l)
	}
}
