package mesh

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// N3: a member at its cap for ordinary records refuses the next one; the sync fails 4508 so the
// sender sees it was not taken, instead of a done that claims it was. The refusal can reach the sender
// before or after it wrote its done; it reads 4508 either way.
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
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for i := range 21 {
		srv, cli := pipe()
		var l Link = cli
		held := i > 0
		if held {
			l = holdDone{cli, ctx}
		}
		go SyncRespond(ctx, srv, full, nil, nil)
		if err := SyncInitiate(ctx, l, sender, nil, nil); relay.CodeOf(err) != wire.CodeMeshFull {
			t.Fatalf("a push into a full mesh (done written after the refusal: %v) returned %v, want a 4508 failure", held, err)
		}
	}
	if full.Has(extra.Hash) {
		t.Fatal("setup: the full member stored the extra record")
	}
}

// holdDone writes the sender's done line only once the session has closed, so the receiver's refusal
// lands between the record and the done.
type holdDone struct {
	*pipeEnd
	ctx context.Context
}

func (h holdDone) Send(b []byte) error {
	if bytes.Contains(b, []byte(`"t":"done"`)) {
		select {
		case <-h.done:
		case <-h.ctx.Done():
		}
	}
	return h.pipeEnd.Send(b)
}

// syncTo runs one mesh session from a fresh pipe, first responding and second dialing.
func syncTo(t *testing.T, first, second *Store) {
	t.Helper()
	srv, cli := pipe()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	go SyncRespond(ctx, srv, first, nil, nil)
	if err := SyncInitiate(ctx, cli, second, nil, nil); err != nil {
		t.Fatalf("sync to a second node: %v", err)
	}
}

// #2864, #2994: in a mesh of the shared epoch (ADR-0026) a member that fills the record space fills only its
// own lineage's share, and a member of another lineage or the founder records its revoke, which every node
// applies.
func TestInASharedMeshAFillersRevokeIsRecordedAndEveryNodeAppliesIt(t *testing.T) {
	for _, revoker := range []string{"another lineage", "the founder"} {
		t.Run(revoker, func(t *testing.T) {
			f, h, o, x := detID(1), detID(2), detID(3), detID(4)
			b, found := newMesh(t, f)
			ah := b.admit(f, h, found)
			ao := b.admit(f, o, ah)
			ax := b.admit(h, x, ao)
			if nonceLineage(ah.B.Card.C.Nonce) == nonceLineage(ao.B.Card.C.Nonce) {
				t.Fatal("setup: h and o share a lineage")
			}
			last := ax
			for i := 0; i < MaxOrdinary; i++ {
				last = b.sign(h, TypeName, []*Record{last}, Fields{Subject: pub(h), Name: fmt.Sprintf("n%d", i)})
			}
			for i := 0; i < MaxRecords-MaxOrdinary; i++ {
				last = b.sign(h, TypeRevoke, []*Record{last}, Fields{Subjects: []string{pub(x)}})
			}
			first, second := sharedStore(b), sharedStore(b)
			if _, err := first.Merge(b.recs); err != nil {
				t.Fatal(err)
			}
			// Each revoke names its signer's own latest record: o has none yet, the founder's is ao.
			by := o
			if revoker == "the founder" {
				by = f
			}
			removal := b.sign(by, TypeRevoke, []*Record{ao}, Fields{Subjects: []string{pub(h)}})
			if added, err := first.Merge([]*Record{removal}); err != nil || len(added) != 1 {
				t.Fatalf("the revoke of the filler: stored %d, %v", len(added), err)
			}
			syncTo(t, first, second)
			for i, s := range []*Store{first, second} {
				if _, ok := s.View().Revoked[pub(h)]; !ok || !s.Has(removal.Hash) {
					t.Fatalf("node %d: holds the revoke %v, counts the filler revoked %v", i+1, s.Has(removal.Hash), ok)
				}
			}
		})
	}
}

// ADR-0026 accepts that a lineage can block itself (#2994): a filler's own revoke spends its own lineage's revoke
// places like its other revokes, so once those hold ShareRevokes revokes that rank before it, it is dropped on
// every node and the filler stays a member; the founder's revoke still reaches every node.
func TestInASharedMeshAFillersOwnRevokeLosesToItsFullRevokePlacesButTheFoundersReachesEveryNode(t *testing.T) {
	f, h, o, x := detID(1), detID(2), detID(3), detID(4)
	b, found := newMesh(t, f)
	ah := b.admit(f, h, found)
	ao := b.admit(f, o, ah)
	ax := b.admit(h, x, ao)
	base := []*Record{found, ah, ao, ax}
	// h's own chain: ax is its record 1, the self revoke its record 2, each filler names the one before.
	self := b.sign(h, TypeRevoke, []*Record{ax}, Fields{Subjects: []string{pub(h)}})
	var fillers []*Record
	prev, n := self, uint64(3)
	for i := 0; len(fillers) < ShareRevokes; i++ {
		subject := bytes.Repeat([]byte{0xee}, 32)
		subject[0], subject[1] = byte(i), byte(i>>8)
		r := b.signN(h, n, TypeRevoke, []*Record{prev}, Fields{Subjects: []string{ident.B64.EncodeToString(subject)}})
		if bytes.Compare(r.Sum[:], self.Sum[:]) < 0 {
			fillers = append(fillers, r)
			prev, n = r, n+1
		}
	}
	hl := nonceLineage(ah.B.Card.C.Nonce)

	// Control: with one of those revokes missing the self revoke fits, and h is revoked.
	control := sharedStore(b)
	if _, err := control.Merge(append(append(append([]*Record(nil), base...), fillers[1:]...), self)); err != nil {
		t.Fatal(err)
	}
	if !control.Has(self.Hash) || isMember(control.View(), h) {
		t.Fatalf("control: the self revoke is stored %v, h a member %v", control.Has(self.Hash), isMember(control.View(), h))
	}

	first, second := sharedStore(b), sharedStore(b)
	if _, err := first.Merge(append(append(append([]*Record(nil), base...), fillers...), self)); err != nil {
		t.Fatal(err)
	}
	if n := keptOf(first, hl, TypeRevoke); n != ShareRevokes {
		t.Fatalf("h's lineage keeps %d revokes, want %d", n, ShareRevokes)
	}
	syncTo(t, first, second)
	for i, s := range []*Store{first, second} {
		if s.Has(self.Hash) || !isMember(s.View(), h) {
			t.Fatalf("node %d: stores the self revoke %v, h a member %v", i+1, s.Has(self.Hash), isMember(s.View(), h))
		}
	}
	removal := b.sign(f, TypeRevoke, []*Record{ao}, Fields{Subjects: []string{pub(h)}})
	if added, err := first.Merge([]*Record{removal}); err != nil || len(added) != 1 {
		t.Fatalf("the founder's revoke of the filler: stored %d, %v", len(added), err)
	}
	syncTo(t, first, second)
	for i, s := range []*Store{first, second} {
		if !s.Has(removal.Hash) || isMember(s.View(), h) {
			t.Fatalf("node %d: holds the founder's revoke %v, h still a member %v", i+1, s.Has(removal.Hash), isMember(s.View(), h))
		}
	}
}

// Q3 (stated limit of version 1 meshes, CONTRACT.md "Records"): the record space has no per-signer share.
// One member can fill it with valid records (ordinary ones to 3840, then revokes to 4096), after which no
// member can record anything, not even the revoke of that member; the remedy is a mesh of the shared epoch.
func TestInAVersionOneMeshOneMemberCanFillTheRecordSpaceSoEvenItsOwnRevokeIsRefused(t *testing.T) {
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
