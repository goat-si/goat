package daemon

import (
	"context"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
)

// An invite nobody asked for must not keep its secret on disk past its expiry: the daemon drops
// expired invites when it starts and on its periodic tick.
func TestAnExpiredInviteNobodyUsedLeavesOffersJSONWhenTheDaemonStarts(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	st := shortDir(t)
	id := identity(t, st, rs.URL, "a")
	if _, err := mesh.Found(st, id, "a", 1); err != nil {
		t.Fatal(err)
	}
	iv, err := mesh.LoadInvites(st)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := iv.Create(time.Minute, time.Now().Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	var before []mesh.Invite
	st.ReadJSON("offers.json", &before)
	if len(before) != 1 {
		t.Fatalf("setup: offers.json holds %d invites", len(before))
	}
	start(t, ctx, rs, st, nil)
	var after []mesh.Invite
	if _, err := st.ReadJSON("offers.json", &after); err != nil {
		t.Fatal(err)
	}
	if len(after) != 0 {
		t.Fatalf("offers.json still holds %d expired invite(s) after the daemon started", len(after))
	}
}
