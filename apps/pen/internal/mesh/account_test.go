package mesh

import (
	"crypto/ed25519"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/login"
)

// rawRecord signs an arbitrary body as by, for record shapes Sign cannot make.
func rawRecord(t *testing.T, by interface{ Priv() ed25519.PrivateKey }, body map[string]any) *Record {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	r := &Record{Body: b, Sig: ed25519.Sign(by.Priv(), digest(recordPrefix, b))}
	return r
}

type signer struct{ k ed25519.PrivateKey }

func (s signer) Priv() ed25519.PrivateKey { return s.k }

func TestUnknownTypesAndMembersAreStoredForwardedAndHaveNoEffect(t *testing.T) {
	a, x := detID(1), detID(2)
	b, found := newMesh(t, a)
	s := NewStore(nil, b.meshID)
	if _, err := s.Merge([]*Record{found}); err != nil {
		t.Fatal(err)
	}
	future := rawRecord(t, signer{a.SignPriv}, map[string]any{"v": 1, "mesh": b.meshID, "type": "future", "by": pub(a),
		"n": 2, "prev": []string{found.Hash}, "at": 2, "color": "blue"})
	card := b.card(x, a, "x")
	extra := rawRecord(t, signer{a.SignPriv}, map[string]any{"v": 1, "mesh": b.meshID, "type": "admit", "by": pub(a),
		"n": 3, "prev": []string{HashOf(future.Body)}, "at": 3, "card": card, "ttl": 5})
	added, err := s.Merge([]*Record{future, extra})
	if err != nil || len(added) != 2 {
		t.Fatalf("stored %d of 2 (%v); a v1.1 node keeps records it does not understand", len(added), err)
	}
	v := s.View()
	if isMember(v, x) || len(v.Members) != 1 {
		t.Fatal("an admit with an unknown member took effect")
	}
	if v.Effective[added[0].Hash] || v.Effective[added[1].Hash] {
		t.Fatal("an unknown record is marked effective")
	}
	if missing := s.missingFrom([]string{found.Hash}); len(missing) != 2 {
		t.Fatalf("a sync forwards %d of the 2 unknown records", len(missing))
	}
	caseVariant := rawRecord(t, signer{a.SignPriv}, map[string]any{"v": 1, "mesh": b.meshID, "type": "future", "by": pub(a),
		"n": 4, "prev": []string{found.Hash}, "at": 4, "Card": "x"})
	if added, _ := s.Merge([]*Record{caseVariant}); len(added) != 0 {
		t.Fatal("a member differing from a known one only by case was stored")
	}
}

func (b *builder) bind(by *ident.Identity, sub string, prev ...*Record) *Record {
	k := LoginKey{Kid: login.Kid(by.NoisePub), Pub: ident.B64.EncodeToString(by.NoisePub)}
	var acct *Account
	if sub != "" {
		acct = &Account{LoginURL: "https://login.example", LoginKey: k, Sub: sub}
	}
	return b.sign(by, TypeAccount, prev, Fields{Bind: acct})
}

func (b *builder) lock(by *ident.Identity, on bool, prev ...*Record) *Record {
	return b.sign(by, TypeLock, prev, Fields{On: on})
}

func sub(v *View) string {
	if v.Account == nil {
		return ""
	}
	return v.Account.Sub
}

func TestTheLastAccountRecordBindsAndANullSubUnbinds(t *testing.T) {
	a, c := detID(1), detID(2)
	b, found := newMesh(t, a)
	adm := b.admit(a, c, found)
	first := b.bind(a, "1001", adm)
	if got := sub(b.view()); got != "1001" {
		t.Fatalf("bound to %q, want 1001", got)
	}
	rebind := b.bind(c, "2002", first)
	if got := sub(b.view()); got != "2002" {
		t.Fatalf("after a rebind: %q, want 2002", got)
	}
	b.bind(a, "", rebind)
	if v := b.view(); v.Account != nil {
		t.Fatalf("after an unbind: %+v, want unbound", v.Account)
	}
}

func TestACompromisedSignersBindingLosesEffectItsLockStaysAndAPlainLeaveKeepsBoth(t *testing.T) {
	a, c, d := detID(1), detID(2), detID(3)
	b, found := newMesh(t, a)
	ac := b.admit(a, c, found)
	ad := b.admit(a, d, ac)
	bind := b.bind(c, "1001", ad)
	lock := b.lock(c, true, bind)
	leave := b.sign(c, TypeRevoke, []*Record{lock}, Fields{Subjects: []string{pub(c)}})
	if v := b.view(); sub(v) != "1001" || !v.Locked {
		t.Fatalf("after c left plainly: sub %q locked %v, want both kept", sub(v), v.Locked)
	}
	revoke := b.sign(d, TypeRevoke, []*Record{leave}, Fields{Subjects: []string{pub(c)}, Compromised: true})
	// A stolen machine's lock must not be undone by revoking it: that would reopen auto-admission.
	if v := b.view(); v.Account != nil || !v.Locked {
		t.Fatalf("c revoked as compromised: account %+v locked %v, want unbound and still locked", v.Account, v.Locked)
	}
	b.lock(d, false, revoke)
	if b.view().Locked {
		t.Fatal("an honest unlock with the compromised lock in its past did not unlock")
	}
}

func TestRevokingTheLockSignerAsCompromisedKeepsABoundMeshLocked(t *testing.T) {
	a, c := detID(1), detID(2)
	b, found := newMesh(t, a)
	adm := b.admit(a, c, found)
	bind := b.bind(a, "1001", adm)
	lock := b.lock(c, true, bind)
	b.sign(a, TypeRevoke, []*Record{lock}, Fields{Subjects: []string{pub(c)}, Compromised: true})
	if v := b.view(); sub(v) != "1001" || !v.Locked {
		t.Fatalf("after revoking the lock signer as compromised: sub %q locked %v; want bound and locked", sub(v), v.Locked)
	}
}

func TestACompromisedSignersUnlockLosesEffect(t *testing.T) {
	a, c := detID(1), detID(2)
	b, found := newMesh(t, a)
	adm := b.admit(a, c, found)
	on := b.lock(a, true, adm)
	off := b.lock(c, false, on)
	if b.view().Locked {
		t.Fatal("setup: c's unlock did not unlock")
	}
	b.sign(a, TypeRevoke, []*Record{off}, Fields{Subjects: []string{pub(c)}, Compromised: true})
	if !b.view().Locked {
		t.Fatal("an unlock signed by a key revoked as compromised still counts")
	}
}

func TestAnUnlockCountsOnlyWithEveryLockInItsPast(t *testing.T) {
	a, c := detID(1), detID(2)
	b, found := newMesh(t, a)
	adm := b.admit(a, c, found)
	onA := b.lock(a, true, adm)
	onC := b.lock(c, true, adm) // concurrent with onA
	b.lock(a, false, onA)
	if !b.view().Locked {
		t.Fatal("an unlock that has only one of two locks in its past unlocked the mesh")
	}
	b.lock(c, false, onA, onC)
	if b.view().Locked {
		t.Fatal("an unlock with every lock in its past did not unlock")
	}
}

func TestAnAdmitViaGoogleShowsTheAccountAndRefusesALongEmail(t *testing.T) {
	a, c := detID(1), detID(2)
	b, found := newMesh(t, a)
	hash := HashOf([]byte("assertion"))
	b.sign(a, TypeAdmit, []*Record{found}, Fields{Card: b.card(c, a, "c"), Via: ViaGoogle, Email: "c@example.com", Assertion: hash})
	m, ok := b.view().Members[pub(c)]
	if !ok || m.Via != ViaGoogle || m.Email != "c@example.com" {
		t.Fatalf("member %+v (%v)", m, ok)
	}
	long := strings.Repeat("x", 250) + "@e.co"
	if _, err := Sign(a, b.meshID, TypeAdmit, 9, []string{found.Hash}, 1, Fields{Card: b.card(detID(4), a, "d"), Via: ViaGoogle, Email: long, Assertion: hash}); err == nil {
		t.Fatal("an email over 254 bytes was signed")
	}
}

func TestAnAccountAdmitNamesAtMostEightHeadsKeepingTheSignersOwn(t *testing.T) {
	a, x := detID(1), detID(40)
	b, found := newMesh(t, a)
	last := found
	var members []*ident.Identity
	for i := range 10 {
		m := detID(byte(10 + i))
		last = b.admit(a, m, last)
		members = append(members, m)
	}
	for _, m := range members {
		b.sign(m, TypeName, []*Record{last}, Fields{Subject: pub(m), Name: "n" + m.NodeID()[:4]})
	}
	s := NewStore(nil, b.meshID)
	s.SetSelf(pub(a))
	if _, err := s.Merge(b.recs); err != nil {
		t.Fatal(err)
	}
	if h := len(s.heads()); h != 10 {
		t.Fatalf("%d heads, want 10", h)
	}
	got, err := AdmitAccount(a, s, b.card(x, a, "x"), Claim{SignPub: pub(x), NoisePub: ident.B64.EncodeToString(x.NoisePub), Email: "x@example.com", Hash: HashOf([]byte("a"))}, time.UnixMilli(5))
	if err != nil {
		t.Fatal(err)
	}
	if n := len(got.admit.B.Prev); n != 8 {
		t.Fatalf("the admit names %d heads, want 8", n)
	}
	if got.admit.B.N != 12 || !isMember(s.View(), x) {
		t.Fatalf("admit n %d, member %v; the signer's own chain must stay in its past", got.admit.B.N, isMember(s.View(), x))
	}
}

func TestUnknownMembersInsideACardOrLoginKeyAreIgnored(t *testing.T) {
	a, x := detID(1), detID(2)
	b, found := newMesh(t, a)
	// x's card body and its wrapper carry a member this version does not know.
	cardBody, _ := json.Marshal(map[string]any{"v": 1, "mesh": b.meshID, "inviter": a.NodeID(), "nonce": b.nextNonce(),
		"nodeId": x.NodeID(), "signPub": pub(x), "noisePub": ident.B64.EncodeToString(x.NoisePub), "name": "x", "color": "blue"})
	cardSig := ed25519.Sign(x.SignPriv, digest(cardPrefix, cardBody))
	card := map[string]any{"body": ident.B64.EncodeToString(cardBody), "sig": ident.B64.EncodeToString(cardSig), "hint": 1}
	admit := rawRecord(t, signer{a.SignPriv}, map[string]any{"v": 1, "mesh": b.meshID, "type": "admit", "by": pub(a),
		"n": 2, "prev": []string{found.Hash}, "at": 2, "card": card})
	key := map[string]any{"kid": login.Kid(a.NoisePub), "pub": ident.B64.EncodeToString(a.NoisePub), "alg": "ed25519"}
	bind := rawRecord(t, signer{a.SignPriv}, map[string]any{"v": 1, "mesh": b.meshID, "type": "account", "by": pub(a),
		"n": 3, "prev": []string{HashOf(admit.Body)}, "at": 3, "loginUrl": "https://login.example", "loginKey": key, "sub": "1001"})
	s := NewStore(nil, b.meshID)
	added, err := s.Merge([]*Record{found, admit, bind})
	if err != nil || len(added) != 3 {
		t.Fatalf("stored %d of 3 (%v); unknown nested members must not drop a record", len(added), err)
	}
	v := s.View()
	if !isMember(v, x) || v.Account == nil || v.Account.Sub != "1001" {
		t.Fatalf("member %v, account %+v; the records must take effect as without the extra members", isMember(v, x), v.Account)
	}
}

func TestASignerRevokedOnlyAsAnAdmitOfACompromisedKeyLosesItsBindingButNotItsLock(t *testing.T) {
	a, c, d := detID(1), detID(2), detID(3)
	b, found := newMesh(t, a)
	ac := b.admit(a, c, found)
	cd := b.admit(c, d, ac)
	bind := b.bind(d, "1001", cd)
	lock := b.lock(d, true, bind)
	if v := b.view(); sub(v) != "1001" || !v.Locked {
		t.Fatalf("before: sub %q locked %v", sub(v), v.Locked)
	}
	b.sign(a, TypeRevoke, []*Record{lock}, Fields{Subjects: []string{pub(c)}, Compromised: true})
	v := b.view()
	if isMember(v, d) {
		t.Fatal("d, admitted by the compromised c, is still a member")
	}
	if v.Account != nil || !v.Locked {
		t.Fatalf("after c was revoked as compromised: d's account %+v, locked %v; want unbound and still locked", v.Account, v.Locked)
	}
}
