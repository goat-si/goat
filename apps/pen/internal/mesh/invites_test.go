package mesh

import (
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/state"
)

// An expired invite's secret must leave offers.json as soon as a join asks for it, not at some
// later save.
func TestAnExpiredInviteIsRemovedFromDiskWhenAJoinAsksForIt(t *testing.T) {
	for _, use := range []string{"lookup", "burn"} {
		t.Run(use, func(t *testing.T) {
			st, err := state.OpenDir(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			now := time.UnixMilli(1_800_000_000_000)
			iv, err := LoadInvites(st)
			if err != nil {
				t.Fatal(err)
			}
			x, err := iv.Create(time.Minute, now)
			if err != nil {
				t.Fatal(err)
			}
			later := now.Add(2 * time.Minute)
			if use == "lookup" {
				if _, ok := iv.Lookup(x.ID, later); ok {
					t.Fatal("expired invite found")
				}
			} else if err := iv.Burn(x.ID, later, CardBody{}, at(later)); err == nil {
				t.Fatal("expired invite burned")
			}
			var onDisk []Invite
			if _, err := st.ReadJSON("offers.json", &onDisk); err != nil {
				t.Fatal(err)
			}
			if len(onDisk) != 0 {
				t.Fatalf("offers.json still holds %d invite(s) after the expired %s", len(onDisk), use)
			}
		})
	}
}
