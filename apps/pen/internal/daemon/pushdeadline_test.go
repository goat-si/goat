package daemon

import (
	"context"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/relaytest"
)

func memberOnline(t *testing.T, n *node, name string) bool {
	t.Helper()
	for _, m := range n.ls(t).Members {
		if m.Name == name {
			return m.Online
		}
	}
	t.Fatalf("%s is not a member", name)
	return false
}

// The refresh before a Google admit waits 5 s at most. A member that took longer to answer is
// slow, not gone: running out of the caller's time must not mark it offline.
func TestAPushCutShortByItsCallersDeadlineLeavesTheMemberOnline(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	_ = b
	a.d.pushAll(ctx)
	if !memberOnline(t, a, "b") {
		t.Fatal("setup: b is not online after a push it took")
	}
	short, stop := context.WithCancel(ctx)
	stop()
	a.d.pushTo(short, a.d.view().SortedMembers())
	if !memberOnline(t, a, "b") {
		t.Fatal("a push the caller gave up on marked b offline")
	}
}
