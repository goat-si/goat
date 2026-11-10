package mesh

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// N3: a member at its cap for ordinary records refuses the next one; the sync fails 4508 so the
// sender sees it was not taken, instead of a done that claims it was.
func TestASyncIntoAFullMeshFailsForTheSender(t *testing.T) {
	f := detID(1)
	b, found := newMesh(t, f)
	recs := []*Record{found}
	last := found
	for i := 1; len(recs) < MaxOrdinary; i++ {
		last = b.sign(f, TypeName, []*Record{last}, Fields{Subject: pub(f), Name: fmt.Sprintf("n%d", i)})
		recs = append(recs, last)
	}
	full := NewStore(nil, b.meshID)
	if added, err := full.Merge(recs); err != nil || len(added) != MaxOrdinary {
		t.Fatalf("setup: stored %d of %d: %v", len(added), MaxOrdinary, err)
	}
	extra := b.sign(f, TypeName, []*Record{last}, Fields{Subject: pub(f), Name: "one-more"})
	sender := NewStore(nil, b.meshID)
	sender.uncapped = true
	if _, err := sender.Merge(append(recs, extra)); err != nil {
		t.Fatal(err)
	}
	srv, cli := pipe()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	go SyncRespond(ctx, srv, full, nil, nil)
	err := SyncInitiate(ctx, cli, sender, nil, nil)
	if relay.CodeOf(err) != wire.CodeMeshFull {
		t.Fatalf("a push into a full mesh returned %v, want a 4508 failure", err)
	}
	if full.Has(extra.Hash) {
		t.Fatal("setup: the full member stored the extra record")
	}
}
