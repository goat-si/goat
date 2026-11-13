package mesh

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

// mixedID is a key pair whose signing key comes from signSeed and Noise key from noiseSeed (as detID makes them).
func mixedID(signSeed, noiseSeed byte) *ident.Identity {
	id, err := ident.FromSeeds(bytes.Repeat([]byte{signSeed}, 32), bytes.Repeat([]byte{noiseSeed ^ 0x5a}, 32))
	if err != nil {
		panic(err)
	}
	return id
}

func subjectOf(id *ident.Identity, name string) Subject {
	return Subject{SignPub: ident.B64.EncodeToString(id.SignPub), NoisePub: ident.B64.EncodeToString(id.NoisePub), Name: name}
}

// joinFixture is a founder's store and invite book with one mesh record.
func joinFixture(t *testing.T) (f *ident.Identity, s *Store, iv *Invites) {
	t.Helper()
	f = detID(1)
	b, found := newMesh(t, f)
	s = NewStore(nil, b.meshID)
	if _, err := s.Merge([]*Record{found}); err != nil {
		t.Fatal(err)
	}
	iv, err := LoadInvites(nil)
	if err != nil {
		t.Fatal(err)
	}
	return f, s, iv
}

// serveOne runs one join of j under name against invite id and returns both sides' errors.
func serveOne(f *ident.Identity, s *Store, iv *Invites, id string, now time.Time, j *ident.Identity, name string) (serveErr, joinErr error) {
	srv, cli := pipe()
	served := make(chan error, 1)
	go func() {
		_, err := ServeJoin(context.Background(), srv, j.NoisePub, Admission{ID: f, Store: s, Invites: iv, InviteID: id,
			Now: func() time.Time { return now }})
		served <- err
	}()
	_, _, joinErr = Join(context.Background(), cli, j, name)
	return <-served, joinErr
}

// A bound invite admits only the machine it names: a card with another signing key, another Noise key or another
// name is refused before the burn, so the invite stays usable, and the subject is then admitted.
func TestBoundInviteAdmitsOnlyItsSubject(t *testing.T) {
	f, s, iv := joinFixture(t)
	now := time.UnixMilli(1_800_000_000_000)
	j := detID(3)
	inv, err := iv.CreateBound(subjectOf(j, "j"), now.Add(time.Minute), now)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		what string
		id   *ident.Identity
		name string
	}{
		{"another signPub", mixedID(4, 3), "j"},
		{"another noisePub", mixedID(3, 4), "j"},
		{"another name", j, "k"},
	} {
		serveErr, joinErr := serveOne(f, s, iv, inv.ID, now, c.id, c.name)
		var refused *RefusedError
		if !errors.As(joinErr, &refused) || serveErr == nil {
			t.Fatalf("%s: join %v, serve %v; want a refusal on both sides", c.what, joinErr, serveErr)
		}
		if _, ok := iv.Lookup(inv.ID, now); !ok || s.Len() != 1 {
			t.Fatalf("%s: invite usable %v, records %d; want the invite unburned and nothing signed", c.what, ok, s.Len())
		}
	}
	if serveErr, joinErr := serveOne(f, s, iv, inv.ID, now, j, "j"); serveErr != nil || joinErr != nil {
		t.Fatalf("subject: serve %v, join %v", serveErr, joinErr)
	}
	if _, member := s.View().Members[pub(j)]; !member {
		t.Fatal("the subject is not a member after its join")
	}
	if _, ok := iv.Lookup(inv.ID, now); ok {
		t.Fatal("the invite is still usable after admitting its subject")
	}
}

// The subject is part of the invite's entry in offers.json, so a bound invite stays bound across a restart.
func TestBoundInviteKeepsItsSubjectOnDisk(t *testing.T) {
	st := tmpState(t)
	now := time.UnixMilli(1_800_000_000_000)
	iv, err := LoadInvites(st)
	if err != nil {
		t.Fatal(err)
	}
	sub := subjectOf(detID(3), "j")
	inv, err := iv.CreateBound(sub, now.Add(time.Minute), now)
	if err != nil {
		t.Fatal(err)
	}
	again, err := LoadInvites(st)
	if err != nil {
		t.Fatal(err)
	}
	x, ok := again.Lookup(inv.ID, now)
	if !ok || x.Subject == nil || *x.Subject != sub {
		t.Fatalf("reloaded invite %+v (found %v); want subject %+v", x, ok, sub)
	}
}

func tmpState(t *testing.T) *state.Store {
	t.Helper()
	st, err := state.OpenDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return st
}
