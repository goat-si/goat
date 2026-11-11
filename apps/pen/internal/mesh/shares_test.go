package mesh

import (
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

// #2864 under ADR-0026: a member that fills the record space with records of its own lineage cannot
// stop a member of another lineage from recording its revoke.
func TestAFillerCannotStopAMemberOfAnotherLineageFromRevokingIt(t *testing.T) {
	f, h, o, x := detID(1), detID(2), detID(3), detID(4)
	b, found := newMesh(t, f)
	ah := b.admit(f, h, found)
	ao := b.admit(f, o, ah)
	ax := b.admit(h, x, ao)
	last := ax
	for i := 0; i < MaxRecords; i++ {
		last = b.sign(h, TypeName, []*Record{last}, Fields{Subject: pub(h), Name: fmt.Sprintf("n%d", i)})
	}
	for i := 0; i < 64; i++ {
		last = b.sign(h, TypeRevoke, []*Record{last}, Fields{Subjects: []string{pub(x)}})
	}
	s := sharedStore(b)
	mergeEach(t, s, b.recs)
	if n := keptOf(s, 1, TypeName); n != ShareOrdinary {
		t.Fatalf("filler's lineage keeps %d names, want its share %d", n, ShareOrdinary)
	}
	if n := keptOf(s, 1, TypeRevoke); n != ShareControl {
		t.Fatalf("filler's lineage keeps %d revokes, want %d", n, ShareControl)
	}
	removal := b.sign(o, TypeRevoke, []*Record{ao}, Fields{Subjects: []string{pub(h)}})
	if added, err := s.Merge([]*Record{removal}); err != nil || len(added) != 1 {
		t.Fatalf("the revoke of the filler: stored %d, %v", len(added), err)
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
		honest = append(honest, b.sign(o, TypeName, []*Record{filler[i*37]}, Fields{Subject: pub(o), Name: fmt.Sprintf("o%d", i)}))
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
	if n := keptOf(a, 1, TypeName); n != ShareOrdinary {
		t.Fatalf("filler lineage keeps %d names, want %d", n, ShareOrdinary)
	}
	if n := keptOf(a, 1, TypeAdmit); n != ShareAdmits {
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
