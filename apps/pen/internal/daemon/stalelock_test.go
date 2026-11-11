package daemon

import (
	"context"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
)

// A member that has not heard of a lock yet (it slept through it, or the push was lost) syncs with the
// other reachable members before it signs a Google admit, so it queues the request instead.
func TestAMemberThatMissedTheLockQueuesAfterSyncingWithAReachableMember(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := loginFake(t)
	a := founder(t, ctx, rs, "a", nil)
	bindTo(t, a, f, f.Key())
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	// a turns the lock on in its own copy only, as if its push to b had been lost.
	if _, err := a.d.mesh().Append(a.d.id, mesh.TypeLock, time.Now().UnixMilli(), mesh.Fields{On: true}); err != nil {
		t.Fatal(err)
	}
	a.d.viewChanged()
	if b.ls(t).Locked {
		t.Fatal("setup: b already knows the lock")
	}
	j := newcomer(t)
	as := f.Issue(testSub, "me@example.com", j.SignPub, j.NoisePub, time.Now())
	out, by, err := AccountJoin(ctx, []string{rs.URL}, j, "j", as, offeredBy(t, b))
	if err != nil {
		t.Fatal(err)
	}
	if out.QueuedID == "" || by.Name != "b" {
		t.Fatalf("b answered %+v, want the request queued on b", out)
	}
}
