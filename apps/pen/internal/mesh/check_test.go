package mesh

import "testing"

// A plain revoke keeps what the revoked key admitted. A node that counts b a member, b having been
// admitted by x before x was revoked plainly, takes a joiner b admitted; once x was revoked as
// compromised (which took b with it) the same joiner is refused.
func TestACheckWalksPastAPlainlyRevokedAdmitterAndStopsAtACompromisedOne(t *testing.T) {
	f, x, bk, j := detID(1), detID(2), detID(3), detID(4)
	for _, compromised := range []bool{false, true} {
		b, found := newMesh(t, f)
		ax := b.admit(f, x, found)
		ab := b.admit(x, bk, ax)
		rv := b.sign(f, TypeRevoke, []*Record{ab}, Fields{Subjects: []string{pub(x)}, Compromised: compromised})
		own := b.view()
		aj := b.admit(bk, j, ab)
		merged := b.view()
		_, _ = rv, aj
		got := admittedCleanly(merged, own, pub(j))
		if want := !compromised; got != want {
			t.Fatalf("x revoked compromised=%v: the check took j %v, want %v", compromised, got, want)
		}
	}
}
