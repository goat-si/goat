package mesh

import "testing"

// The listed check's walk (contract "Account join"): from the joiner toward the founder through
// the admits it was given, it takes the joiner at the first key the receiver's own view counts
// as a current member, refuses at the first admitter the receiver's own view revoked (plainly or
// as compromised), and walks through admitters it never heard of.
func TestTheListedCheckStopsAtACurrentMemberAndAtARevokedAdmitter(t *testing.T) {
	f, x, y, bk, j := detID(1), detID(2), detID(3), detID(4), detID(5)
	cases := []struct {
		name string
		// build returns the receiver's own records and the merged copy the check judges.
		build func(b *builder, found *Record) (own, merged []*Record)
		want  bool
	}{
		{"b, admitted by x before x was revoked plainly, is current here and admits j", func(b *builder, found *Record) ([]*Record, []*Record) {
			ax := b.admit(f, x, found)
			ab := b.admit(x, bk, ax)
			rv := b.sign(f, TypeRevoke, []*Record{ab}, Fields{Subjects: []string{pub(x)}})
			aj := b.admit(bk, j, rv)
			own := []*Record{found, ax, ab, rv}
			return own, append(own[:4:4], aj)
		}, true},
		{"x, revoked plainly here, admits j in a copy where its revoke lost the race", func(b *builder, found *Record) ([]*Record, []*Record) {
			ax := b.admit(f, x, found)
			rv := b.sign(f, TypeRevoke, []*Record{ax}, Fields{Subjects: []string{pub(x)}})
			aj := b.admit(x, j, ax)
			// A stolen key that wins the canonical order leaves x a member and j admitted.
			return []*Record{found, ax, rv}, []*Record{found, ax, aj}
		}, false},
		{"x, revoked as compromised here, admits j in a copy where its revoke lost the race", func(b *builder, found *Record) ([]*Record, []*Record) {
			ax := b.admit(f, x, found)
			rv := b.sign(f, TypeRevoke, []*Record{ax}, Fields{Subjects: []string{pub(x)}, Compromised: true})
			aj := b.admit(x, j, ax)
			return []*Record{found, ax, rv}, []*Record{found, ax, aj}
		}, false},
		{"y, admitted by x before x's plain revoke but not heard of here, admits j", func(b *builder, found *Record) ([]*Record, []*Record) {
			ax := b.admit(f, x, found)
			ay := b.admit(x, y, ax)
			rv := b.sign(f, TypeRevoke, []*Record{ax}, Fields{Subjects: []string{pub(x)}})
			aj := b.admit(y, j, ay)
			return []*Record{found, ax, rv}, []*Record{found, ax, ay, rv, aj}
		}, false},
	}
	for _, c := range cases {
		b, found := newMesh(t, f)
		own, merged := c.build(b, found)
		if got := admittedCleanly(Compute(b.meshID, merged), Compute(b.meshID, own), pub(j)); got != c.want {
			t.Errorf("%s: the check took j %v, want %v", c.name, got, c.want)
		}
	}
}
