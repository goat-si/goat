package mesh

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// A mesh founded in the shared epoch (ADR-0026) follows shares from its found record alone, signs
// version 2 records that name their own previous record, and drops version 1 records claiming its id.
func TestAMeshOfTheSharedEpochSignsVersionTwoRecordsThatNameTheirOwnPrevious(t *testing.T) {
	f := detID(1)
	s, err := FoundV(EpochShared, nil, f, "f", 1)
	if err != nil {
		t.Fatal(err)
	}
	if !s.Shared() {
		t.Fatal("a mesh founded in the shared epoch does not follow shares")
	}
	first, err := s.Append(f, TypeName, 2, Fields{Subject: pub(f), Name: "a"})
	if err != nil {
		t.Fatal(err)
	}
	// The founder admits o, and o signs after it, so the founder's latest record is no longer a tip.
	o := detID(2)
	card, err := MakeCard(o, s.MeshID, f.NodeID(), ident.B64.EncodeToString(make([]byte, 16)), "o")
	if err != nil {
		t.Fatal(err)
	}
	admit, err := s.Append(f, TypeAdmit, 3, Fields{Card: card})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Append(o, TypeName, 4, Fields{Subject: pub(o), Name: "o"}); err != nil {
		t.Fatal(err)
	}
	second, err := s.Append(f, TypeName, 5, Fields{Subject: pub(f), Name: "b"})
	if err != nil {
		t.Fatal(err)
	}
	if first.B.V != EpochShared || second.B.V != EpochShared {
		t.Fatalf("records signed with versions %d and %d, want %d", first.B.V, second.B.V, EpochShared)
	}
	if !slices.Contains(second.B.Prev, admit.Hash) {
		t.Fatalf("the founder's next record names %v, not its own previous record", second.B.Prev)
	}
	old, err := Sign(f, s.MeshID, TypeName, 9, []string{second.Hash}, 4, Fields{Subject: pub(f), Name: "old"})
	if err != nil {
		t.Fatal(err)
	}
	if added, _ := s.Merge([]*Record{old}); len(added) != 0 || s.Has(old.Hash) {
		t.Fatal("a version 1 record was stored in a mesh of the shared epoch")
	}
	joined, err := FromJoin(nil, s.MeshID, s.Records())
	if err != nil {
		t.Fatal(err)
	}
	if !joined.Shared() {
		t.Fatal("a node joining a mesh of the shared epoch does not follow shares")
	}
}

// Under shares a record's own previous one counts only when named directly in its prev.
func TestUnderSharesARecordWhoseOwnPreviousIsOnlyInItsPastHasNoEffect(t *testing.T) {
	f, o := detID(1), detID(2)
	b, found := newMesh(t, f)
	ao := b.admit(f, o, found)
	n1 := b.sign(o, TypeName, []*Record{ao}, Fields{Subject: pub(o), Name: "one"})
	other := b.sign(f, TypeName, []*Record{n1}, Fields{Subject: pub(f), Name: "f"})
	n2 := b.sign(o, TypeName, []*Record{other}, Fields{Subject: pub(o), Name: "two"})
	shared := compute(b.meshID, b.recs, nil, true)
	if shared.Effective[n2.Hash] {
		t.Fatal("a record whose own previous one is only in its past took effect under shares")
	}
	if !Compute(b.meshID, b.recs).Effective[n2.Hash] {
		t.Fatal("setup: the record has no effect under the version 1 rule either")
	}
}

// A node of a mesh of the shared epoch closes a sync whose peer does not announce it, with 4509.
func TestASharedMeshRefusesASyncFromANodeThatDoesNotAnnounceIt(t *testing.T) {
	f := detID(1)
	s, err := FoundV(EpochShared, nil, f, "f", 1)
	if err != nil {
		t.Fatal(err)
	}
	peer := NewStore(nil, s.MeshID)
	srv, cli := pipe()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	go SyncInitiateAs(ctx, cli, peer, nil, nil, Version)
	if err := SyncRespond(ctx, srv, s, nil, nil); relay.CodeOf(err) != wire.CodeEpoch {
		t.Fatalf("sync with a 1.1 peer returned %v, want a %d close", err, wire.CodeEpoch)
	}
	other, err := FromJoin(nil, s.MeshID, s.Records())
	if err != nil {
		t.Fatal(err)
	}
	srv, cli = pipe()
	go SyncInitiate(ctx, cli, other, nil, nil)
	if err := SyncRespond(ctx, srv, s, nil, nil); err != nil {
		t.Fatalf("sync between two shared nodes: %v", err)
	}
}
