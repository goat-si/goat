package daemon

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
)

func TestAWallClockJumpPastTheAwakeClockRedialsTheUplinks(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	clk := &clock{}
	clk.advance(time.Hour)
	ticks := make(chan time.Time, 2)
	st := shortDir(t)
	id := identity(t, st, rs.URL, "a")
	if _, err := mesh.Found(st, id, "a", 1); err != nil {
		t.Fatal(err)
	}
	var awake atomic.Int64
	a := startWith(t, ctx, rs, st, func(o *Options) {
		o.Now = clk.now
		o.Awake = func() time.Duration { return time.Duration(awake.Load()) }
		o.WakeTicks = ticks
	})
	if err := rs.NextUplink(ctx, a.d.NodeID()); err != nil {
		t.Fatal(err)
	}
	clk.advance(5 * time.Minute)
	// The awake clock stops while the machine sleeps: it saw one tick's worth.
	awake.Add(int64(5 * time.Second))
	ticks <- time.Time{}
	if err := rs.NextUplink(ctx, a.d.NodeID()); err != nil {
		t.Fatalf("no new uplink after the wall clock jumped: %v", err)
	}
}
