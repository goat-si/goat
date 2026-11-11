package mesh

import (
	"bytes"
	"fmt"
	"slices"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/state"
)

func sharedStore(b *builder) *Store {
	s := NewStore(nil, b.meshID)
	s.SetLineageShares()
	return s
}

func mergeEach(t *testing.T, s *Store, recs []*Record) {
	t.Helper()
	for _, r := range recs {
		if _, err := s.Merge([]*Record{r}); err != nil {
			t.Fatal(err)
		}
	}
}

// keptOf counts the kept records of lineage l of one type.
func keptOf(s *Store, l int, typ string) int {
	recs := s.Records()
	lin := Lineages(recs)
	n := 0
	for _, r := range recs {
		if k, ok := lin[r.Hash]; ok && k == l && r.B.Type == typ {
			n++
		}
	}
	return n
}

func hashesOf(s *Store) []string {
	var out []string
	for _, r := range s.Records() {
		out = append(out, r.Hash)
	}
	slices.Sort(out)
	return out
}

// #2864 under ADR-0026: a member that fills the record space with records of its own lineage, and fills
// its revoke and lock places too, cannot stop a member of another lineage, or the founder, from recording
// its revoke; another lineage's own full lock share does not stop it either.
func TestAFillerCannotStopAMemberOfAnotherLineageFromRevokingIt(t *testing.T) {
	f, h, o, x := detID(1), detID(2), detID(3), detID(4)
	b, found := newMesh(t, f)
	ah := b.admit(f, h, found)
	ao := b.admit(f, o, ah)
	ax := b.admit(h, x, ao)
	hl, ol := nonceLineage(ah.B.Card.C.Nonce), nonceLineage(ao.B.Card.C.Nonce)
	if hl == ol {
		t.Fatalf("setup: h and o share lineage %d", hl)
	}
	last := ax
	for i := 0; i < MaxRecords; i++ {
		last = b.sign(h, TypeName, []*Record{last}, Fields{Subject: pub(h), Name: fmt.Sprintf("n%d", i)})
	}
	for i := 0; i < 64; i++ {
		last = b.sign(h, TypeRevoke, []*Record{last}, Fields{Subjects: []string{pub(x)}})
		last = b.sign(h, TypeLock, []*Record{last}, Fields{On: i%2 == 0})
	}
	honest := ao
	for i := 0; i < 2*ShareLocks; i++ {
		honest = b.sign(o, TypeLock, []*Record{honest}, Fields{On: i%2 == 0})
	}
	s := sharedStore(b)
	mergeEach(t, s, b.recs)
	for _, c := range []struct {
		typ  string
		want int
	}{{TypeName, ShareOrdinary}, {TypeLock, ShareLocks}, {TypeRevoke, 1}} {
		if n := keptOf(s, hl, c.typ); n != c.want {
			t.Fatalf("filler's lineage keeps %d %s records, want %d", n, c.typ, c.want)
		}
	}
	removal := b.sign(o, TypeRevoke, []*Record{honest}, Fields{Subjects: []string{pub(h)}})
	byFounder := b.sign(f, TypeRevoke, []*Record{ao}, Fields{Subjects: []string{pub(h)}})
	if added, err := s.Merge([]*Record{removal, byFounder}); err != nil || len(added) != 2 {
		t.Fatalf("the revokes of the filler by another lineage and the founder: stored %d, %v", len(added), err)
	}
	if _, ok := s.View().Revoked[pub(h)]; !ok {
		t.Fatal("the filler is still a member after another lineage revoked it")
	}
}

// ADR-0026 convergence and honest history: two nodes given the same records in opposite orders keep the
// same records and bare hashes, and honest records whose only parent is a filler's record that did not
// fit are kept.
func TestSharedStoresAgreeWhateverTheArrivalOrder(t *testing.T) {
	f, h, o, x := detID(1), detID(2), detID(3), detID(4)
	b, found := newMesh(t, f)
	ah := b.admit(f, h, found)
	ao := b.admit(f, o, ah)
	ax := b.admit(h, x, ao)
	var filler []*Record
	for i := 0; i < ShareOrdinary+60; i++ {
		filler = append(filler, b.sign(x, TypeName, []*Record{ax}, Fields{Subject: pub(x), Name: fmt.Sprintf("f%d", i)}))
	}
	for i := 0; i < 6*ShareAdmits; i++ {
		b.admit(h, detID(byte(100+i)), ax)
	}
	var honest []*Record
	for i := 0; i < 8; i++ {
		honest = append(honest, b.sign(o, TypeName, []*Record{filler[i*(ShareOrdinary/8)]}, Fields{Subject: pub(o), Name: fmt.Sprintf("o%d", i)}))
	}
	recs := slices.Clone(b.recs)
	rev := slices.Clone(recs)
	slices.Reverse(rev)
	a, c := sharedStore(b), sharedStore(b)
	mergeEach(t, a, recs)
	mergeEach(t, c, rev)
	// What sync does: each side sends what it keeps until neither learns anything.
	for round := 0; round < 3; round++ {
		if _, err := c.Merge(a.Records()); err != nil {
			t.Fatal(err)
		}
		if _, err := a.Merge(c.Records()); err != nil {
			t.Fatal(err)
		}
	}
	if !slices.Equal(hashesOf(a), hashesOf(c)) {
		t.Fatalf("kept sets differ after exchange: %d vs %d records", len(hashesOf(a)), len(hashesOf(c)))
	}
	if !slices.Equal(a.Bare(), c.Bare()) {
		t.Fatalf("bare hashes differ: %d vs %d", len(a.Bare()), len(c.Bare()))
	}
	hl := nonceLineage(ah.B.Card.C.Nonce)
	if n := keptOf(a, hl, TypeName); n != ShareOrdinary {
		t.Fatalf("filler lineage keeps %d names, want %d", n, ShareOrdinary)
	}
	if n := keptOf(a, hl, TypeAdmit); n != ShareAdmits {
		t.Fatalf("filler lineage keeps %d admits, want %d", n, ShareAdmits)
	}
	if len(a.Bare()) == 0 {
		t.Fatal("setup: no honest record names a left-out filler record")
	}
	for _, r := range honest {
		if !a.Has(r.Hash) || !c.Has(r.Hash) {
			t.Fatalf("honest record %s was lost (a %v, c %v)", r.Hash, a.Has(r.Hash), c.Has(r.Hash))
		}
	}
}

// A save of a shared store keeps records another process wrote to the file, within the shares.
func TestASharedSaveKeepsRecordsAnotherProcessWroteWithinTheShares(t *testing.T) {
	f, o := detID(1), detID(2)
	b, found := newMesh(t, f)
	ao := b.admit(f, o, found)
	named := b.sign(o, TypeName, []*Record{ao}, Fields{Subject: pub(o), Name: "o"})
	st, err := state.OpenDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	daemonSide := NewStore(st, b.meshID)
	daemonSide.SetLineageShares()
	if _, err := daemonSide.Merge([]*Record{found, ao}); err != nil {
		t.Fatal(err)
	}
	if err := daemonSide.Save(); err != nil {
		t.Fatal(err)
	}
	cliSide, err := Load(st)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cliSide.Merge([]*Record{named}); err != nil {
		t.Fatal(err)
	}
	if err := cliSide.Save(); err != nil {
		t.Fatal(err)
	}
	if err := daemonSide.Save(); err != nil {
		t.Fatal(err)
	}
	reloaded, err := Load(st)
	if err != nil {
		t.Fatal(err)
	}
	if !reloaded.Has(named.Hash) {
		t.Fatal("a save of the shared store dropped a record another process wrote")
	}
}

// A revoke that arrives before its subject's admit is kept once the admit arrives, as when the admit
// comes first: the kept set does not depend on arrival order.
func TestARevokeArrivingBeforeItsSubjectsAdmitIsKept(t *testing.T) {
	f, o, x := detID(1), detID(2), detID(3)
	b, found := newMesh(t, f)
	ao := b.admit(f, o, found)
	revoke := b.sign(o, TypeRevoke, []*Record{ao}, Fields{Subjects: []string{pub(x)}})
	ax := b.admit(f, x, ao)
	for _, order := range [][]*Record{{found, ao, revoke, ax}, {found, ao, ax, revoke}} {
		s := sharedStore(b)
		mergeEach(t, s, order)
		if !s.Has(revoke.Hash) {
			t.Fatalf("revoke lost when it arrives at position %d", slices.Index(order, revoke))
		}
	}
}

// An admit this version cannot read is an ordinary record of its signer's lineage: kept within that
// share, never dropped for being an admit nobody introduced.
func TestAnOpaqueAdmitCountsAsAnOrdinaryRecordOfItsLineage(t *testing.T) {
	f, o, x := detID(1), detID(2), detID(3)
	b, found := newMesh(t, f)
	ao := b.admit(f, o, found)
	opaque := rawRecord(t, signer{o.SignPriv}, map[string]any{"v": 1, "mesh": b.meshID, "type": "admit", "by": pub(o),
		"n": 1, "prev": []string{ao.Hash}, "at": 3, "card": b.card(x, o, "x"), "ttl": 5})
	s := sharedStore(b)
	mergeEach(t, s, []*Record{found, ao, opaque})
	if !s.Has(HashOf(opaque.Body)) {
		t.Fatal("an opaque admit was dropped instead of kept as an ordinary record")
	}
}

// When a signer loses its kept admit, which of its records wait in the bounded pool depends only on
// the records, not on map iteration order.
func TestRecordsOfASignerThatLostItsAdmitPoolTheSameEverywhere(t *testing.T) {
	f, h := detID(1), detID(2)
	b, found := newMesh(t, f)
	ah := b.admit(f, h, found)
	var admits []*Record
	for i := 0; i <= ShareAdmits; i++ {
		admits = append(admits, b.admit(h, detID(byte(100+i)), ah))
	}
	victim := slices.MaxFunc(admits, func(a, c *Record) int { return bytes.Compare(a.Sum[:], c.Sum[:]) })
	vid := detID(byte(100 + slices.Index(admits, victim)))
	var own []*Record
	for i := 0; i < 3*MaxPoolPerSigner; i++ {
		own = append(own, b.sign(vid, TypeName, []*Record{victim}, Fields{Subject: pub(vid), Name: fmt.Sprintf("v%d", i)}))
	}
	var want []string
	for run := 0; run < 6; run++ {
		s := sharedStore(b)
		mergeEach(t, s, []*Record{found, ah, victim})
		if _, err := s.Merge(own); err != nil {
			t.Fatal(err)
		}
		for _, a := range admits {
			if a != victim {
				mergeEach(t, s, []*Record{a})
			}
		}
		if s.Has(victim.Hash) {
			t.Fatal("setup: the largest admit still fits its lineage's share")
		}
		var pooled []string
		for h := range s.pool {
			pooled = append(pooled, h)
		}
		slices.Sort(pooled)
		if run == 0 {
			want = pooled
		} else if !slices.Equal(pooled, want) {
			t.Fatalf("run %d pools different records of the displaced signer", run)
		}
	}
}


// Two processes that each save records within a share, but together more than it, leave the file with
// the share's smallest hashes: the merged save applies the shares to the union.
func TestASharedSaveOfTwoProcessesKeepsOnlyTheShareOfTheirUnion(t *testing.T) {
	f, o := detID(1), detID(2)
	b, found := newMesh(t, f)
	ao := b.admit(f, o, found)
	var names []*Record
	for i := 0; i < 2*ShareOrdinary; i++ {
		names = append(names, b.sign(o, TypeName, []*Record{ao}, Fields{Subject: pub(o), Name: fmt.Sprintf("o%d", i)}))
	}
	st, err := state.OpenDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	daemonSide := NewStore(st, b.meshID)
	daemonSide.SetLineageShares()
	if _, err := daemonSide.Merge(append([]*Record{found, ao}, names[:ShareOrdinary]...)); err != nil {
		t.Fatal(err)
	}
	if err := daemonSide.Save(); err != nil {
		t.Fatal(err)
	}
	cliSide := NewStore(st, b.meshID)
	cliSide.SetLineageShares()
	if _, err := cliSide.Merge(append([]*Record{found, ao}, names[ShareOrdinary:]...)); err != nil {
		t.Fatal(err)
	}
	if err := cliSide.Save(); err != nil {
		t.Fatal(err)
	}
	reloaded, err := Load(st)
	if err != nil {
		t.Fatal(err)
	}
	sorted := slices.Clone(names)
	sortByHash(sorted)
	for i, r := range sorted {
		if reloaded.Has(r.Hash) != (i < ShareOrdinary) {
			t.Fatalf("name %d by hash: kept %v, want %v", i, reloaded.Has(r.Hash), i < ShareOrdinary)
		}
	}
}

