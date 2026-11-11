package mesh

import (
	"context"
	"errors"
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

// Q3 (stated limit, CONTRACT.md "Records"): the record space has no per-signer share. One member can
// fill it with valid records (ordinary ones to 3840, then revokes to 4096), after which no member can
// record anything, not even the revoke of that member; the remedy is a new mesh.
func TestOneMemberCanFillTheRecordSpaceSoEvenItsOwnRevokeIsRefused(t *testing.T) {
	f, h, x := detID(1), detID(2), detID(3)
	b, found := newMesh(t, f)
	ah := b.admit(f, h, found)
	ax := b.admit(h, x, ah)
	recs := []*Record{found, ah, ax}
	last := ax
	for i := 1; len(recs) < MaxOrdinary; i++ {
		last = b.sign(h, TypeName, []*Record{last}, Fields{Subject: pub(h), Name: fmt.Sprintf("n%d", i)})
		recs = append(recs, last)
	}
	for len(recs) < MaxRecords {
		last = b.sign(h, TypeRevoke, []*Record{last}, Fields{Subjects: []string{pub(x)}})
		recs = append(recs, last)
	}
	s := NewStore(nil, b.meshID)
	if added, err := s.Merge(recs); err != nil || len(added) != MaxRecords {
		t.Fatalf("setup: stored %d of %d: %v", len(added), MaxRecords, err)
	}
	removal := b.sign(f, TypeRevoke, []*Record{last}, Fields{Subjects: []string{pub(h)}})
	if _, err := s.Merge([]*Record{removal}); !errors.Is(err, ErrFull) {
		t.Fatalf("the revoke of the member that filled the space: %v, want ErrFull", err)
	}
	if _, ok := s.View().Members[pub(h)]; !ok {
		t.Fatal("setup: h is not a member")
	}
}
