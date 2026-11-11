package mesh

import (
	"math/rand"
	"testing"
)

// ADR-0026: a key a member admits joins that member's lineage, so admitting keys never opens new room.
func TestAKeyAdmittedByAMemberJoinsThatMembersLineage(t *testing.T) {
	f := detID(1)
	b, found := newMesh(t, f)
	m1, m2, m3, x, y := detID(2), detID(3), detID(4), detID(5), detID(6)
	a1 := b.admit(f, m1, found)
	a2 := b.admit(f, m2, a1)
	a3 := b.admit(f, m3, a2)
	ax := b.admit(m3, x, a3)
	ay := b.admit(x, y, ax)
	named := b.sign(y, TypeName, []*Record{ay}, Fields{Subject: pub(y), Name: "y"})
	got := Lineages(b.recs)
	for _, c := range []struct {
		name string
		r    *Record
		want int
	}{{"found", found, 0}, {"founder's first admit", a1, 0}, {"third direct admit's subject admitting", ax, 3}, {"grandchild admitting", ay, 3}, {"grandchild's record", named, 3}} {
		if k, ok := got[c.r.Hash]; !ok || k != c.want {
			t.Errorf("%s: lineage %d (known %v), want %d", c.name, k, ok, c.want)
		}
	}
	if k := got[a2.Hash]; k != 0 {
		t.Errorf("the founder's own admit is charged to the founder: lineage %d, want 0", k)
	}
}

// ADR-0026: only the founder's first 15 direct admits start lineages; later ones join the founder's.
func TestTheFoundersSixteenthDirectAdmitJoinsLineageZero(t *testing.T) {
	f := detID(1)
	b, found := newMesh(t, f)
	last := found
	var subjects []*Record
	for i := 0; i < MaxLineages; i++ {
		s := detID(byte(10 + i))
		last = b.admit(f, s, last)
		subjects = append(subjects, b.sign(s, TypeName, []*Record{last}, Fields{Subject: pub(s), Name: "s"}))
	}
	got := Lineages(b.recs)
	for i, r := range subjects {
		want := i + 1
		if want >= MaxLineages {
			want = 0
		}
		if k, ok := got[r.Hash]; !ok || k != want {
			t.Errorf("subject of direct admit %d: lineage %d (known %v), want %d", i+1, k, ok, want)
		}
	}
}

// A record whose signer was never introduced in its own past is charged to no lineage.
func TestARecordWhoseSignerIsNotIntroducedInItsPastHasNoLineage(t *testing.T) {
	f, outsider := detID(1), detID(9)
	b, found := newMesh(t, f)
	r := b.sign(outsider, TypeName, []*Record{found}, Fields{Subject: pub(outsider), Name: "o"})
	if k, ok := Lineages(b.recs)[r.Hash]; ok {
		t.Fatalf("outsider's record got lineage %d", k)
	}
}

// Every node agrees: the lineages do not depend on the order records are given in.
func TestLineagesDoNotDependOnRecordOrder(t *testing.T) {
	f := detID(1)
	b, found := newMesh(t, f)
	last := found
	for i := 0; i < 6; i++ {
		s := detID(byte(20 + i))
		last = b.admit(f, s, last)
		last = b.admit(s, detID(byte(40+i)), last)
	}
	want := Lineages(b.recs)
	rng := rand.New(rand.NewSource(1))
	for i := 0; i < 20; i++ {
		recs := append([]*Record(nil), b.recs...)
		rng.Shuffle(len(recs), func(i, j int) { recs[i], recs[j] = recs[j], recs[i] })
		got := Lineages(recs)
		if len(got) != len(want) {
			t.Fatalf("shuffle %d: %d records with a lineage, want %d", i, len(got), len(want))
		}
		for h, k := range want {
			if got[h] != k {
				t.Fatalf("shuffle %d: record %s lineage %d, want %d", i, h, got[h], k)
			}
		}
	}
}
