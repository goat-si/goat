package mesh

import (
	"math/rand"
	"slices"
	"testing"
)

// ADR-0026: a key a member admits joins that member's lineage, so admitting keys never opens new room;
// the founder alone is lineage 0.
func TestAKeyAdmittedByAMemberJoinsThatMembersLineage(t *testing.T) {
	f := detID(1)
	b, found := newMesh(t, f)
	m, x, y := detID(2), detID(5), detID(6)
	am := b.admit(f, m, found)
	ax := b.admit(m, x, am)
	ay := b.admit(x, y, ax)
	named := b.sign(y, TypeName, []*Record{ay}, Fields{Subject: pub(y), Name: "y"})
	want := nonceLineage(am.B.Card.C.Nonce)
	got := Lineages(b.meshID, b.recs)
	for _, c := range []struct {
		name string
		r    *Record
		want int
	}{{"found", found, 0}, {"the founder's admit", am, 0}, {"its subject admitting", ax, want}, {"a grandchild admitting", ay, want}, {"a grandchild's record", named, want}} {
		if k, ok := got[c.r.Hash]; !ok || k != c.want {
			t.Errorf("%s: lineage %d (known %v), want %d", c.name, k, ok, c.want)
		}
	}
	if want < 1 || want >= MaxLineages {
		t.Fatalf("a founder's admit starts lineage %d, want 1 to %d", want, MaxLineages-1)
	}
}

// Review of #2963: a founder's admit arriving later must not renumber the lineages of the others, or
// records dropped for a full share could have fitted. The lineage comes from the invite nonce alone.
func TestALaterFounderAdmitDoesNotRenumberTheOthers(t *testing.T) {
	f := detID(1)
	b, found := newMesh(t, f)
	last := found
	var subjects []*Record
	for i := 0; i < 20; i++ {
		s := detID(byte(10 + i))
		last = b.admit(f, s, last)
		subjects = append(subjects, b.sign(s, TypeName, []*Record{last}, Fields{Subject: pub(s), Name: "s"}))
	}
	all := Lineages(b.meshID, b.recs)
	// A node that has not received the founder's first five admits yet (each admit is followed by its
	// subject's name record) gives the remaining subjects the lineages they keep later.
	partial := Lineages(b.meshID, append([]*Record{found}, b.recs[11:]...))
	for _, r := range subjects[5:] {
		k, ok := partial[r.Hash]
		if !ok || k != all[r.Hash] {
			t.Fatalf("a subject's lineage is %d (known %v) without the earlier admits, %d with them", k, ok, all[r.Hash])
		}
	}
}

// Review of #2963: a key admitting itself does not change how it was introduced (its depth stays defined).
// A member cannot replay another key's card: verification refuses an admit whose card names another inviter.
func TestASelfAdmitDoesNotMoveAKey(t *testing.T) {
	f, m, n, k := detID(1), detID(2), detID(3), detID(4)
	b, found := newMesh(t, f)
	am := b.admit(f, m, found)
	an := b.admit(f, n, am)
	ak := b.admit(m, k, an)
	before := Lineages(b.meshID, b.recs)
	self := b.admit(k, k, ak)
	named := b.sign(k, TypeName, []*Record{self}, Fields{Subject: pub(k), Name: "k"})
	keys, _ := introductions(b.meshID, b.recs, false)
	if got := keys[pub(k)]; got.lineage != before[ak.Hash] || got.depth != 2 {
		t.Fatalf("k moved to lineage %d at depth %d, want lineage %d at depth 2", got.lineage, got.depth, before[ak.Hash])
	}
	if l := Lineages(b.meshID, b.recs)[named.Hash]; l != before[ak.Hash] {
		t.Fatalf("k's record is charged to lineage %d, want %d", l, before[ak.Hash])
	}
}

// A record whose signer was never admitted is charged to no lineage.
func TestARecordWhoseSignerWasNeverAdmittedHasNoLineage(t *testing.T) {
	f, outsider := detID(1), detID(9)
	b, found := newMesh(t, f)
	r := b.sign(outsider, TypeName, []*Record{found}, Fields{Subject: pub(outsider), Name: "o"})
	if k, ok := Lineages(b.meshID, b.recs)[r.Hash]; ok {
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
	want := Lineages(b.meshID, b.recs)
	rng := rand.New(rand.NewSource(1))
	for i := 0; i < 20; i++ {
		recs := append([]*Record(nil), b.recs...)
		rng.Shuffle(len(recs), func(i, j int) { recs[i], recs[j] = recs[j], recs[i] })
		got := Lineages(b.meshID, recs)
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

// Regression #2979: lineages anchor on the found record of the mesh itself. A set that also holds another mesh's
// self-signed found record (and an admit by that founder) gives the same lineages whichever comes first, and
// keeps neither foreign record.
func TestLineagesAnchorOnTheMeshsOwnFoundRecordWhateverTheOrder(t *testing.T) {
	f, m, x := detID(1), detID(2), detID(3)
	b, found := newMesh(t, f)
	am := b.admit(f, m, found)
	b.admit(m, x, am)
	g := detID(7)
	other, otherFound := newMesh(t, g)
	otherAdmit := other.admit(g, detID(8), otherFound)
	want := Lineages(b.meshID, b.recs)
	for name, recs := range map[string][]*Record{
		"other mesh first": append([]*Record{otherFound, otherAdmit}, b.recs...),
		"other mesh last":  append(slices.Clone(b.recs), otherFound, otherAdmit),
	} {
		t.Run(name, func(t *testing.T) {
			got := Lineages(b.meshID, recs)
			if len(got) != len(want) {
				t.Fatalf("%d records have a lineage, want %d (the mesh's own)", len(got), len(want))
			}
			for h, l := range want {
				if k, ok := got[h]; !ok || k != l {
					t.Fatalf("record %s: lineage %d (known %v), want %d", h, k, ok, l)
				}
			}
			_, kept := introductions(b.meshID, recs, true)
			for _, r := range kept {
				if r == otherFound || r == otherAdmit {
					t.Fatalf("kept the other mesh's %s record", r.B.Type)
				}
			}
		})
	}
}
