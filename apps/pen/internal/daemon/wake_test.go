package daemon

import (
	"context"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
)

func TestAWallClockJumpPastTheMonotonicClockRedialsTheUplinks(t *testing.T) {
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
	a := startWith(t, ctx, rs, st, func(o *Options) {
		o.Now = clk.now
		// The monotonic clock stops while the machine sleeps: it saw one tick's worth.
		o.Since = func(time.Time) time.Duration { return 5 * time.Second }
		o.WakeTicks = ticks
	})
	if err := rs.NextUplink(ctx, a.d.NodeID()); err != nil {
		t.Fatal(err)
	}
	clk.advance(5 * time.Minute)
	ticks <- time.Time{}
	if err := rs.NextUplink(ctx, a.d.NodeID()); err != nil {
		t.Fatalf("no new uplink after the wall clock jumped: %v", err)
	}
}
