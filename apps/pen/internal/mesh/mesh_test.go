package mesh

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"reflect"
	"sort"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

func detID(seed byte) *ident.Identity {
	id, err := ident.FromSeeds(bytes.Repeat([]byte{seed}, 32), bytes.Repeat([]byte{seed ^ 0x5a}, 32))
	if err != nil {
		panic(err)
	}
	return id
}

func pub(id *ident.Identity) string { return ident.B64.EncodeToString(id.SignPub) }

// builder signs records with explicit prev so tests can shape the DAG.
type builder struct {
	t      *testing.T
	meshID string
	recs   []*Record
	n      map[string]uint64
	nonce  int
}

func newMesh(t *testing.T, founder *ident.Identity) (*builder, *Record) {
	b := &builder{t: t, n: map[string]uint64{}}
	card, err := MakeCard(founder, "-", "-", b.nextNonce(), "founder")
	if err != nil {
		t.Fatal(err)
	}
	r, err := Sign(founder, "-", TypeFound, 1, nil, 1, Fields{Card: card})
	if err != nil {
		t.Fatal(err)
	}
	b.meshID = MeshIDOf(r)
	b.n[pub(founder)] = 1
	b.recs = append(b.recs, r)
	return b, r
}

func (b *builder) nextNonce() string {
	b.nonce++
	nb := make([]byte, 16)
	nb[0], nb[1] = byte(b.nonce), byte(b.nonce>>8)
	return ident.B64.EncodeToString(nb)
}

func (b *builder) card(subject, inviter *ident.Identity, name string) *Card {
	c, err := MakeCard(subject, b.meshID, inviter.NodeID(), b.nextNonce(), name)
	if err != nil {
		b.t.Fatal(err)
	}
	return c
}

func (b *builder) sign(by *ident.Identity, typ string, prev []*Record, f Fields) *Record {
	b.n[pub(by)]++
	return b.signN(by, b.n[pub(by)], typ, prev, f)
}

func (b *builder) signN(by *ident.Identity, n uint64, typ string, prev []*Record, f Fields) *Record {
	hs := make([]string, len(prev))
	for i, p := range prev {
		hs[i] = p.Hash
	}
	r, err := Sign(by, b.meshID, typ, n, hs, int64(len(b.recs)+1), f)
	if err != nil {
		b.t.Fatal(err)
	}
	b.recs = append(b.recs, r)
	return r
}

func (b *builder) admit(by, subject *ident.Identity, prev ...*Record) *Record {
	return b.sign(by, TypeAdmit, prev, Fields{Card: b.card(subject, by, fmt.Sprintf("n%d", b.nonce))})
}

func (b *builder) view() *View { return Compute(b.meshID, b.recs) }

func isMember(v *View, id *ident.Identity) bool { _, ok := v.Members[pub(id)]; return ok }

type viewSummary struct {
	Members, Revoked []Member
	Order            []string
	Effective        []string
}

func summarize(v *View) viewSummary {
	var eff []string
	for h := range v.Effective {
		eff = append(eff, h)
	}
	sort.Strings(eff)
	return viewSummary{v.SortedMembers(), v.SortedRevoked(), v.Order, eff}
}

// randomDAG generates a 30-record mesh history with concurrent branches and every record type.
func randomDAG(t *testing.T, rng *rand.Rand) *builder {
	ids := []*ident.Identity{}
	for i := range 8 {
		ids = append(ids, detID(byte(i+1)))
	}
	b, found := newMesh(t, ids[0])
	last := map[string]*Record{pub(ids[0]): found}
	joined := []*ident.Identity{ids[0]}
	waiting := ids[1:]
	for len(b.recs) < 30 {
		signer := joined[rng.IntN(len(joined))]
		prev := map[*Record]bool{}
		if r := last[pub(signer)]; r != nil {
			prev[r] = true
		}
		for range rng.IntN(3) {
			prev[b.recs[rng.IntN(len(b.recs))]] = true
		}
		if len(prev) == 0 {
			prev[found] = true
		}
		ps := make([]*Record, 0, len(prev))
		for p := range prev {
			ps = append(ps, p)
		}
		var r *Record
		switch k := rng.IntN(10); {
		case k < 3 && len(waiting) > 0:
			subject := waiting[0]
			waiting = waiting[1:]
			r = b.admit(signer, subject, ps...)
			joined = append(joined, subject)
		case k < 5:
			subject := joined[rng.IntN(len(joined))]
			r = b.sign(signer, TypeName, ps, Fields{Subject: pub(subject), Name: fmt.Sprintf("name-%d", len(b.recs))})
		case k < 7:
			r = b.sign(signer, TypeHostKeys, ps, Fields{Keys: []string{fmt.Sprintf("ssh-ed25519 AAAA%d", len(b.recs))}})
		case k < 8 && len(joined) > 2:
			// The founder is never revoked, so later records still have a live signer.
			subject := joined[1+rng.IntN(len(joined)-1)]
			r = b.sign(signer, TypeRevoke, ps, Fields{Subjects: []string{pub(subject)}, Compromised: rng.IntN(2) == 0})
		default:
			r = b.sign(signer, TypeName, ps, Fields{Subject: pub(signer), Name: fmt.Sprintf("self-%d", len(b.recs))})
		}
		last[pub(signer)] = r
	}
	return b
}

func TestSameSetInAnyArrivalOrderGivesTheSameView(t *testing.T) {
	for seed := range uint64(5) {
		rng := rand.New(rand.NewPCG(seed, 7))
		b := randomDAG(t, rng)
		want := summarize(b.view())
		if len(want.Order) != 30 || len(want.Effective) < 10 {
			t.Fatalf("seed %d: generated %d records, %d effective", seed, len(want.Order), len(want.Effective))
		}
		for range 40 {
			perm := rng.Perm(len(b.recs))
			s := NewStore(nil, b.meshID)
			for _, i := range perm {
				var copyRec Record
				raw, _ := json.Marshal(b.recs[i])
				if err := json.Unmarshal(raw, &copyRec); err != nil {
					t.Fatal(err)
				}
				if _, err := s.Merge([]*Record{&copyRec}); err != nil {
					t.Fatal(err)
				}
			}
			if got := summarize(s.View()); !reflect.DeepEqual(got, want) {
				t.Fatalf("seed %d: view differs for arrival order %v", seed, perm)
			}
		}
	}
}

func TestNonMembersAdmitHasNoEffect(t *testing.T) {
	f, x, y := detID(1), detID(2), detID(3)
	b, found := newMesh(t, f)
	b.admit(x, y, found)
	v := b.view()
	if isMember(v, y) || isMember(v, x) || len(v.Members) != 1 {
		t.Fatal("an outsider admitted someone")
	}
}

func TestCompromisedRevokeRemovesTheKeysTheSubjectAdmittedTransitively(t *testing.T) {
	f, a, bb, c, d := detID(1), detID(2), detID(3), detID(4), detID(5)
	b, found := newMesh(t, f)
	ra := b.admit(f, a, found)
	rd := b.admit(f, d, ra)
	rb := b.admit(a, bb, rd)
	rc := b.admit(bb, c, rb)
	b.sign(f, TypeRevoke, []*Record{rc}, Fields{Subjects: []string{pub(a)}, Compromised: true})
	v := b.view()
	for _, k := range []*ident.Identity{a, bb, c} {
		if isMember(v, k) {
			t.Fatalf("%s survived a compromised revoke of its admitter chain", k.NodeID())
		}
		if _, ok := v.Revoked[pub(k)]; !ok {
			t.Fatal("not marked revoked")
		}
	}
	if !isMember(v, f) || !isMember(v, d) {
		t.Fatal("unrelated members were removed")
	}
}

func TestPlainRevokeKeepsTheSubjectsAdmits(t *testing.T) {
	f, a, bb := detID(1), detID(2), detID(3)
	b, found := newMesh(t, f)
	ra := b.admit(f, a, found)
	rb := b.admit(a, bb, ra)
	b.sign(f, TypeRevoke, []*Record{rb}, Fields{Subjects: []string{pub(a)}})
	v := b.view()
	if isMember(v, a) || !isMember(v, bb) {
		t.Fatal("plain revoke must remove only its subject")
	}
}

func TestRevokedKeyCannotBeReadmitted(t *testing.T) {
	f, a := detID(1), detID(2)
	b, found := newMesh(t, f)
	ra := b.admit(f, a, found)
	rv := b.sign(f, TypeRevoke, []*Record{ra}, Fields{Subjects: []string{pub(a)}})
	b.admit(f, a, rv)
	if isMember(b.view(), a) {
		t.Fatal("revoked key came back")
	}
}

func TestUsedCardNonceDoesNotAdmitTwice(t *testing.T) {
	f, a, c := detID(1), detID(2), detID(3)
	b, found := newMesh(t, f)
	ca := b.card(a, f, "a")
	ra := b.sign(f, TypeAdmit, []*Record{found}, Fields{Card: ca})
	cc, err := MakeCard(c, b.meshID, f.NodeID(), ca.C.Nonce, "c")
	if err != nil {
		t.Fatal(err)
	}
	b.sign(f, TypeAdmit, []*Record{ra}, Fields{Card: cc})
	v := b.view()
	if !isMember(v, a) || isMember(v, c) {
		t.Fatal("a card nonce admitted twice")
	}
}

func TestForkSameSignerAndCounterHasNoEffect(t *testing.T) {
	f := detID(1)
	b, found := newMesh(t, f)
	r1 := b.signN(f, 2, TypeName, []*Record{found}, Fields{Subject: pub(f), Name: "left"})
	r2 := b.signN(f, 2, TypeName, []*Record{found}, Fields{Subject: pub(f), Name: "right"})
	first, second := r1, r2
	if r2.Hash < r1.Hash {
		first, second = r2, r1
	}
	v := b.view()
	if !v.Effective[first.Hash] || v.Effective[second.Hash] {
		t.Fatal("both forks took effect, or the wrong one")
	}
	if v.Members[pub(f)].Name != first.B.Name {
		t.Fatalf("name %q, want %q", v.Members[pub(f)].Name, first.B.Name)
	}
}

func TestRecordWhosePredecessorIsNotInItsPastHasNoEffect(t *testing.T) {
	f := detID(1)
	b, found := newMesh(t, f)
	b.signN(f, 2, TypeName, []*Record{found}, Fields{Subject: pub(f), Name: "two"})
	skip := b.signN(f, 3, TypeName, []*Record{found}, Fields{Subject: pub(f), Name: "three"})
	if b.view().Effective[skip.Hash] {
		t.Fatal("n=3 took effect without n=2 in its past")
	}
}

func TestDuplicateNoisePubAdmitHasNoEffect(t *testing.T) {
	f, a := detID(1), detID(2)
	clash, _ := ident.FromSeeds(bytes.Repeat([]byte{9}, 32), bytes.Repeat([]byte{2 ^ 0x5a}, 32))
	b, found := newMesh(t, f)
	ra := b.admit(f, a, found)
	b.admit(f, clash, ra)
	if isMember(b.view(), clash) {
		t.Fatal("a second member with the same noisePub was admitted")
	}
}

func TestStoreDropsForeignAndForgedRecordsAndPoolsOrphans(t *testing.T) {
	f, a := detID(1), detID(2)
	b, found := newMesh(t, f)
	ra := b.admit(f, a, found)
	other, _ := newMesh(t, detID(7))
	forged := *ra
	forged.Sig = bytes.Repeat([]byte{1}, 64)
	s := NewStore(nil, b.meshID)
	added, err := s.Merge([]*Record{ra, other.recs[0], &forged})
	if err != nil || len(added) != 0 || s.Len() != 0 {
		t.Fatalf("stored %d before its prev arrived", len(added))
	}
	added, _ = s.Merge([]*Record{found})
	if len(added) != 2 || s.Len() != 2 {
		t.Fatalf("pooled record was not released: %d", len(added))
	}
}

// lineCounter counts records lines sent through a link.
type lineCounter struct {
	relay.Conn
	records int
}

func (l *lineCounter) Send(p []byte) error {
	l.records += bytes.Count(p, []byte(`{"t":"records"`))
	return l.Conn.Send(p)
}

func TestThreeHundredRecordsSyncAcrossSeveralLinesAndPushIsTakenOnDone(t *testing.T) {
	f := detID(1)
	full, err := Found(nil, f, "f", 1)
	if err != nil {
		t.Fatal(err)
	}
	for i := range 299 {
		if _, err := full.Append(f, TypeName, int64(i), Fields{Subject: pub(f), Name: fmt.Sprintf("n%d", i)}); err != nil {
			t.Fatal(err)
		}
	}
	peer := NewStore(nil, full.MeshID)
	peer.Merge(full.Records()[:1])
	a, b := relay.Pipe()
	counter := &lineCounter{Conn: a}
	errc := make(chan error, 1)
	go func() { errc <- SyncRespond(context.Background(), b, peer, nil) }()
	if err := SyncInitiate(context.Background(), counter, full, nil); err != nil {
		t.Fatal(err)
	}
	if peer.Len() != 300 {
		t.Fatalf("peer holds %d records when the initiator saw done", peer.Len())
	}
	if err := <-errc; err != nil {
		t.Fatal(err)
	}
	if counter.records != 5 {
		t.Fatalf("%d records lines, want 5 of at most 64", counter.records)
	}
	if !reflect.DeepEqual(summarize(peer.View()), summarize(full.View())) {
		t.Fatal("views differ after sync")
	}
}

func TestOversizedLineAndOverlongHaveClose4400(t *testing.T) {
	for _, line := range [][]byte{
		bytes.Repeat([]byte("x"), MaxLine+1),
		[]byte(`{"t":"hello","have":[` + string(bytes.Repeat([]byte(`"a",`), maxHave)) + `"a"]}` + "\n"),
	} {
		a, b := relay.Pipe()
		for len(line) > 0 {
			n := min(len(line), maxRecord)
			a.Send(line[:n])
			line = line[n:]
		}
		c := &Lines{L: b}
		if _, err := c.Read(context.Background()); relay.CodeOf(err) != wire.CodeCrypto {
			t.Fatalf("got %v, want 4400", err)
		}
		if _, err := a.Recv(context.Background()); relay.CodeOf(err) != wire.CodeCrypto {
			t.Fatalf("peer saw %v, want 4400", err)
		}
	}
}
