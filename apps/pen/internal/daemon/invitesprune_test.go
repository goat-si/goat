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

// The prune tick takes the invite book, then a join replaces the mesh and its book: the old
// book's prune must not write the old mesh's invites back into offers.json.
func TestAPruneOfTheOldInviteBookAfterTheMeshIsReplacedWritesNothing(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	old := a.d.inviteBook()
	now := time.Now()
	if _, err := old.Create(time.Minute, now); err != nil {
		t.Fatal(err)
	}
	live, err := old.Create(time.Hour, now)
	if err != nil {
		t.Fatal(err)
	}
	other, err := mesh.Found(nil, a.id, "a", 2)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.d.replaceMesh(other, nil, "a"); err != nil {
		t.Fatal(err)
	}
	// The tick runs once the short invite expired.
	if err := old.Prune(now.Add(2 * time.Minute)); err != nil {
		t.Fatal(err)
	}
	var saved []mesh.Invite
	if _, err := a.st.ReadJSON("offers.json", &saved); err != nil {
		t.Fatal(err)
	}
	for _, x := range saved {
		if x.ID == live.ID {
			t.Fatal("offers.json holds the replaced mesh's invite again")
		}
	}
}
