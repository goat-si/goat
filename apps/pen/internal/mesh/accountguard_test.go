package mesh

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/login"
	"github.com/goat-si/goat/apps/pen/internal/relay"
)

// pipeEnd is one end of an in-memory Link.
type pipeEnd struct {
	in, out chan []byte
	done    chan struct{}
	once    *sync.Once
	code    *uint16 // the close code, set once before done closes
}

func pipe() (*pipeEnd, *pipeEnd) {
	a, b := make(chan []byte, 64), make(chan []byte, 64)
	done, once, code := make(chan struct{}), &sync.Once{}, new(uint16)
	return &pipeEnd{in: a, out: b, done: done, once: once, code: code}, &pipeEnd{in: b, out: a, done: done, once: once, code: code}
}

func (p *pipeEnd) Send(b []byte) error {
	select {
	case p.out <- append([]byte(nil), b...):
		return nil
	case <-p.done:
		return errors.New("closed")
	}
}

func (p *pipeEnd) Recv(ctx context.Context) ([]byte, error) {
	select {
	case b := <-p.in:
		return b, nil
	case <-p.done:
		select {
		case b := <-p.in:
			return b, nil
		default:
		}
		if *p.code != 0 {
			return nil, &relay.CloseError{Code: *p.code}
		}
		return nil, errors.New("closed")
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (p *pipeEnd) Close(code uint16) error {
	p.once.Do(func() { *p.code = code; close(p.done) })
	return nil
}

// A member that learns of its own revoke during the refresh before a Google join decides, signs
// nothing and queues nothing: it refuses as not a member, so the joiner can try another.
func TestAMemberThatLearnsItsRevokeDuringTheRefreshAdmitsAndQueuesNothing(t *testing.T) {
	for _, locked := range []bool{false, true} {
		f, y, j := detID(1), detID(2), detID(3)
		b, found := newMesh(t, f)
		ay := b.admit(f, y, found)
		recs := []*Record{found, ay}
		if locked {
			recs = append(recs, b.sign(f, TypeLock, []*Record{ay}, Fields{On: true}))
		}
		s := NewStore(nil, b.meshID)
		if _, err := s.Merge(recs); err != nil {
			t.Fatal(err)
		}
		if locked && !s.View().Locked {
			t.Fatal("setup: the mesh is not locked")
		}
		rv := b.sign(f, TypeRevoke, recs[len(recs)-1:], Fields{Subjects: []string{pub(y)}})
		queued := 0
		srv, cli := pipe()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		served := make(chan error, 1)
		go func() {
			_, err := ServeAccount(ctx, srv, j.NoisePub, AccountAdmission{ID: y, Store: s, Now: time.Now,
				Check: func(json.RawMessage, *View) (Claim, error) {
					return Claim{SignPub: pub(j), NoisePub: ident.B64.EncodeToString(j.NoisePub), Email: "j@example.com", Hash: HashOf([]byte("assertion"))}, nil
				},
				Queue:   func(*Card, Claim) (string, error) { queued++; return "q", nil },
				Refresh: func() { s.Merge([]*Record{rv}) },
			})
			served <- err
		}()
		_, err := AccountJoin(ctx, cli, j, "j", json.RawMessage(`{"a":1}`))
		serr := <-served
		cancel()
		var refused *RefusedError
		if !errors.As(err, &refused) || !refused.NotMember {
			t.Fatalf("locked %v: the joiner got %v (served %v), want a not-a-member refusal", locked, err, serr)
		}
		if queued != 0 || s.Len() != len(recs)+1 {
			t.Fatalf("locked %v: queued %d request(s); the store holds %d records, want %d", locked, queued, s.Len(), len(recs)+1)
		}
	}
}

// L2: a revoke that merges after the inviter's old membership check, before the burn and the
// signature, still stops the join: the invite stays usable and nothing is signed.
func TestAnInviteRacingTheInvitersRevokeIsRefusedAndStaysUsable(t *testing.T) {
	f, y, j := detID(1), detID(2), detID(3)
	b, found := newMesh(t, f)
	ay := b.admit(f, y, found)
	s := NewStore(nil, b.meshID)
	if _, err := s.Merge([]*Record{found, ay}); err != nil {
		t.Fatal(err)
	}
	rv := b.sign(f, TypeRevoke, []*Record{ay}, Fields{Subjects: []string{pub(y)}})
	iv, _ := LoadInvites(nil)
	inv, err := iv.Create(time.Minute, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	srv, cli := pipe()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	served := make(chan error, 1)
	go func() {
		_, err := ServeJoin(ctx, srv, j.NoisePub, Admission{ID: y, Store: s, Invites: iv, InviteID: inv.ID,
			Now: func() time.Time { s.Merge([]*Record{rv}); return time.Now() }})
		served <- err
	}()
	_, _, err = Join(ctx, cli, j, "j")
	<-served
	var refused *RefusedError
	if !errors.As(err, &refused) || !refused.NotMember {
		t.Fatalf("the joiner got %v, want a not-a-member refusal", err)
	}
	if _, ok := iv.Lookup(inv.ID, time.Now()); !ok {
		t.Fatal("the invite was burned for a join that could not count")
	}
	if s.Len() != 3 {
		t.Fatalf("the store holds %d records, want found, y's admit and the revoke", s.Len())
	}
}

// L2: the same for a Google join, between its last check and the signature (unlocked) or the
// queueing (locked).
func TestAGoogleJoinRacingTheMembersRevokeSignsAndQueuesNothing(t *testing.T) {
	for _, locked := range []bool{false, true} {
		f, y, j := detID(1), detID(2), detID(3)
		b, found := newMesh(t, f)
		ay := b.admit(f, y, found)
		recs := []*Record{found, ay}
		if locked {
			recs = append(recs, b.sign(f, TypeLock, []*Record{ay}, Fields{On: true}))
		}
		s := NewStore(nil, b.meshID)
		if _, err := s.Merge(recs); err != nil {
			t.Fatal(err)
		}
		rv := b.sign(f, TypeRevoke, recs[len(recs)-1:], Fields{Subjects: []string{pub(y)}})
		checks, queued := 0, 0
		srv, cli := pipe()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		served := make(chan error, 1)
		go func() {
			_, err := ServeAccount(ctx, srv, j.NoisePub, AccountAdmission{ID: y, Store: s,
				// The decision's Now (unlocked) and its second Check (locked) come after the last
				// membership check of the code before; the revoke merges there.
				Now: func() time.Time {
					if !locked && checks == 2 {
						s.Merge([]*Record{rv})
					}
					return time.Now()
				},
				Check: func(json.RawMessage, *View) (Claim, error) {
					if checks++; locked && checks == 2 {
						s.Merge([]*Record{rv})
					}
					return Claim{SignPub: pub(j), NoisePub: ident.B64.EncodeToString(j.NoisePub), Email: "j@example.com", Hash: HashOf([]byte("assertion"))}, nil
				},
				Queue: func(*Card, Claim) (string, error) { queued++; return "q", nil },
			})
			served <- err
		}()
		_, err := AccountJoin(ctx, cli, j, "j", json.RawMessage(`{"a":1}`))
		serr := <-served
		cancel()
		var refused *RefusedError
		if !errors.As(err, &refused) || !refused.NotMember {
			t.Fatalf("locked %v: the joiner got %v (served %v), want a not-a-member refusal", locked, err, serr)
		}
		if queued != 0 || s.Len() != len(recs)+1 {
			t.Fatalf("locked %v: queued %d; the store holds %d records, want %d", locked, queued, s.Len(), len(recs)+1)
		}
	}
}

// N2: a lock or an unbind merged after the first look but before the signature takes effect: the
// decision is made again with the signature under the store's lock, so a lock queues the request
// and an unbind refuses it, and no admit is signed.
func TestALockOrUnbindMergedBeforeTheSignatureIsHonoured(t *testing.T) {
	keyPub, _, _ := ed25519.GenerateKey(nil)
	bind := &Account{LoginURL: "https://login.example", LoginKey: LoginKey{Kid: login.Kid(keyPub), Pub: ident.B64.EncodeToString(keyPub)}, Sub: "1"}
	for _, c := range []struct {
		name         string
		change       Fields
		typ          string
		queued, sign bool
	}{
		{"lock", Fields{On: true}, TypeLock, true, false},
		{"unbind", Fields{}, TypeAccount, false, false},
	} {
		f, y, j := detID(1), detID(2), detID(3)
		b, found := newMesh(t, f)
		ay := b.admit(f, y, found)
		ac := b.sign(f, TypeAccount, []*Record{ay}, Fields{Bind: bind})
		recs := []*Record{found, ay, ac}
		s := NewStore(nil, b.meshID)
		if _, err := s.Merge(recs); err != nil {
			t.Fatal(err)
		}
		change := b.sign(f, c.typ, []*Record{ac}, c.change)
		queued := 0
		srv, cli := pipe()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		served := make(chan error, 1)
		checks := 0
		go func() {
			_, err := ServeAccount(ctx, srv, j.NoisePub, AccountAdmission{ID: y, Store: s,
				Now: func() time.Time {
					if checks == 2 {
						s.Merge([]*Record{change})
					}
					return time.Now()
				},
				Check: func(_ json.RawMessage, v *View) (Claim, error) {
					checks++
					if v.Account == nil {
						return Claim{}, errors.New("this mesh is not bound to a Google account")
					}
					return Claim{SignPub: pub(j), NoisePub: ident.B64.EncodeToString(j.NoisePub), Email: "j@example.com", Hash: HashOf([]byte("assertion"))}, nil
				},
				Queue: func(*Card, Claim) (string, error) { queued++; return "q", nil },
			})
			served <- err
		}()
		out, err := AccountJoin(ctx, cli, j, "j", json.RawMessage(`{"a":1}`))
		<-served
		cancel()
		if got := out.QueuedID != ""; got != c.queued || (queued == 1) != c.queued {
			t.Fatalf("%s: queued %v (%d), want %v; joiner error %v", c.name, got, queued, c.queued, err)
		}
		if !c.queued && err == nil {
			t.Fatalf("%s: the join went through", c.name)
		}
		if n := s.Len(); n != len(recs)+1 {
			t.Fatalf("%s: the store holds %d records, want %d: an admit was signed", c.name, n, len(recs)+1)
		}
	}
}

// W1: an inviter that moved to another mesh (its store retired by replaceMesh) while a join waited
// for the card signs nothing and burns nothing; the joiner is refused and told to get a new invite.
func TestAnInviteJoinToAStoreRetiredMeanwhileIsRefused(t *testing.T) {
	f, j := detID(1), detID(3)
	b, found := newMesh(t, f)
	s := NewStore(nil, b.meshID)
	if _, err := s.Merge([]*Record{found}); err != nil {
		t.Fatal(err)
	}
	iv, _ := LoadInvites(nil)
	inv, err := iv.Create(time.Minute, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	srv, cli := pipe()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	served := make(chan error, 1)
	go func() {
		_, err := ServeJoin(ctx, srv, j.NoisePub, Admission{ID: f, Store: s, Invites: iv, InviteID: inv.ID,
			Now: func() time.Time { s.Retire(); return time.Now() }})
		served <- err
	}()
	_, _, err = Join(ctx, cli, j, "j")
	<-served
	var refused *RefusedError
	if !errors.As(err, &refused) || !refused.NotMember {
		t.Fatalf("the joiner got %v, want a refusal telling it the invite was not used", err)
	}
	if _, ok := iv.Lookup(inv.ID, time.Now()); !ok {
		t.Fatal("the retired mesh's invite was burned")
	}
	if s.Len() != 1 {
		t.Fatalf("the retired store holds %d records, want only the founding one", s.Len())
	}
}

// Concurrency invariant: retirement takes effect only under the store's lock, so it cannot land inside an
// admission between the burn and the signature; an admission already under way finishes first.
func TestInviteBurnSerializesWithRetire(t *testing.T) {
	f, j := detID(1), detID(3)
	b, found := newMesh(t, f)
	// Nothing else holds r.mu, so TryLock fails inside the hook only if Retire holds it while it sets the flag.
	r := NewStore(nil, b.meshID)
	sets, unlocked := 0, false
	r.retireSets = func() {
		sets++
		if r.mu.TryLock() {
			r.mu.Unlock()
			unlocked = true
		}
	}
	r.Retire()
	if sets != 1 || unlocked {
		t.Fatalf("Retire reached the flag %d time(s), want 1; the store's lock was free there: %v", sets, unlocked)
	}
	s := NewStore(nil, b.meshID)
	if _, err := s.Merge([]*Record{found}); err != nil {
		t.Fatal(err)
	}
	iv, err := LoadInvites(nil)
	if err != nil {
		t.Fatal(err)
	}
	inv, err := iv.Create(time.Minute, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	s.burnGate = func() { close(entered); <-release }
	srv, cli := pipe()
	served := make(chan error, 1)
	joined := make(chan error, 1)
	go func() {
		_, err := ServeJoin(context.Background(), srv, j.NoisePub, Admission{ID: f, Store: s, Invites: iv, InviteID: inv.ID, Now: time.Now})
		served <- err
	}()
	go func() { _, _, err := Join(context.Background(), cli, j, "j"); joined <- err }()
	<-entered
	started, retired := make(chan struct{}), make(chan struct{})
	go func() { close(started); s.Retire(); close(retired) }()
	<-started
	close(release)
	serveErr, joinErr := <-served, <-joined
	<-retired
	_, usable := iv.Lookup(inv.ID, time.Now())
	signed := s.Len() == 2
	if !usable != signed {
		t.Fatalf("invite burned=%v signed=%v; serve=%v join=%v", !usable, signed, serveErr, joinErr)
	}
	if usable || !signed || serveErr != nil || joinErr != nil {
		t.Fatalf("admission did not finish before retirement: burned=%v signed=%v serve=%v join=%v", !usable, signed, serveErr, joinErr)
	}
	if !s.retired.Load() {
		t.Fatal("store was not retired")
	}
}
