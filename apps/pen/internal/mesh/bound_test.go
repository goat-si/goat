package mesh

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
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
	inv, err := iv.CreateBound(subjectOf(j, "j"), "", now.Add(time.Minute), now)
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
	inv, err := iv.CreateBound(sub, "", now.Add(time.Minute), now)
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

// Concurrency invariant: a cancel and a join of one bound invite are ordered by the book's lock, so exactly one
// wins, and each side says which: the cancel answers cancelled and the join is refused, or the join is admitted and
// the cancel answers burned.
func TestCancelRacingAJoinHasExactlyOneWinner(t *testing.T) {
	now := time.UnixMilli(1_800_000_000_000)
	j := detID(3)
	check := func(t *testing.T, s *Store, cancelState string, serveErr, joinErr error) {
		t.Helper()
		admitted := serveErr == nil && joinErr == nil
		switch {
		case cancelState == InviteCancelled && !admitted && serveErr != nil && joinErr != nil && s.Len() == 1:
		case cancelState == InviteBurned && admitted && s.Len() == 2:
		default:
			t.Fatalf("cancel answered %q; serve %v, join %v, records %d", cancelState, serveErr, joinErr, s.Len())
		}
	}
	t.Run("the cancel lands between the join's checks and its burn", func(t *testing.T) {
		f, s, iv := joinFixture(t)
		inv, err := iv.CreateBound(subjectOf(j, "j"), "", now.Add(time.Minute), now)
		if err != nil {
			t.Fatal(err)
		}
		entered, release := make(chan struct{}), make(chan struct{})
		s.burnGate = func() { close(entered); <-release }
		type result struct{ serve, join error }
		done := make(chan result, 1)
		go func() {
			serveErr, joinErr := serveOne(f, s, iv, inv.ID, now, j, "j")
			done <- result{serveErr, joinErr}
		}()
		<-entered
		state, err := iv.Cancel(inv.ID, "", now)
		if err != nil {
			t.Fatal(err)
		}
		close(release)
		r := <-done
		if state != InviteCancelled {
			t.Fatalf("cancel answered %q while the join waited before its burn; want cancelled", state)
		}
		check(t, s, state, r.serve, r.join)
	})
	t.Run("the join burns first", func(t *testing.T) {
		f, s, iv := joinFixture(t)
		inv, err := iv.CreateBound(subjectOf(j, "j"), "", now.Add(time.Minute), now)
		if err != nil {
			t.Fatal(err)
		}
		serveErr, joinErr := serveOne(f, s, iv, inv.ID, now, j, "j")
		state, err := iv.Cancel(inv.ID, "", now)
		if err != nil {
			t.Fatal(err)
		}
		check(t, s, state, serveErr, joinErr)
	})
	t.Run("concurrently", func(t *testing.T) {
		for range 16 {
			f, s, iv := joinFixture(t)
			inv, err := iv.CreateBound(subjectOf(j, "j"), "", now.Add(time.Minute), now)
			if err != nil {
				t.Fatal(err)
			}
			start := make(chan struct{})
			var serveErr, joinErr error
			joined := make(chan struct{})
			go func() {
				<-start
				serveErr, joinErr = serveOne(f, s, iv, inv.ID, now, j, "j")
				close(joined)
			}()
			close(start)
			state, err := iv.Cancel(inv.ID, "", now)
			if err != nil {
				t.Fatal(err)
			}
			<-joined
			if state == InviteCancelled || state == InviteBurned {
				check(t, s, state, serveErr, joinErr)
				continue
			}
			t.Fatalf("cancel answered %q", state)
		}
	})
}

// A cancel by mintId that arrives before its create leaves a fence: the create is refused and makes nothing, so a
// mint delayed past a withdrawal never produces a usable token.
func TestCancelByMintIDBeforeTheCreateRefusesTheCreate(t *testing.T) {
	st := tmpState(t)
	now := time.UnixMilli(1_800_000_000_000)
	iv, err := LoadInvites(st)
	if err != nil {
		t.Fatal(err)
	}
	state, err := iv.Cancel("", "mint-1", now)
	if err != nil || state != InviteCancelled {
		t.Fatalf("cancel of an unmade mint: %q, %v; want cancelled", state, err)
	}
	again, err := LoadInvites(st)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := again.CreateBound(subjectOf(detID(3), "j"), "mint-1", now.Add(time.Minute), now); !errors.Is(err, ErrMintCancelled) {
		t.Fatalf("create after the cancel (book reloaded): %v; want ErrMintCancelled", err)
	}
	var onDisk []Invite
	if _, err := st.ReadJSON("offers.json", &onDisk); err != nil || len(onDisk) != 1 || onDisk[0].ID != "" {
		t.Fatalf("offers.json %+v (%v); want only the fence", onDisk, err)
	}
	if _, err := again.CreateBound(subjectOf(detID(3), "j"), "mint-2", now.Add(time.Minute), now); err != nil {
		t.Fatalf("another mint: %v", err)
	}
	if _, err := again.CreateBound(subjectOf(detID(3), "j"), "mint-2", now.Add(time.Minute), now); !errors.Is(err, ErrMintUsed) {
		t.Fatalf("the same mint twice: %v; want ErrMintUsed", err)
	}
}

// Expiry, cancel and burn each leave a terminal entry that a restart (the book read again from offers.json) still
// reports, so a bound invite is never deleted silently.
func TestBoundInviteTerminalStatesSurviveARestart(t *testing.T) {
	f, s, _ := joinFixture(t)
	st := tmpState(t)
	iv, err := LoadInvites(st)
	if err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1_800_000_000_000)
	j := detID(3)
	mint := func(m string) Invite {
		t.Helper()
		x, err := iv.CreateBound(subjectOf(j, "j"), m, now.Add(time.Minute), now)
		if err != nil {
			t.Fatal(err)
		}
		return x
	}
	burned, cancelled, lapsed := mint("burn"), mint("cancel"), mint("expire")
	if serveErr, joinErr := serveOne(f, s, iv, burned.ID, now, j, "j"); serveErr != nil || joinErr != nil {
		t.Fatalf("join: %v, %v", serveErr, joinErr)
	}
	if _, err := iv.Cancel(cancelled.ID, "", now); err != nil {
		t.Fatal(err)
	}
	later := now.Add(2 * time.Minute)
	if err := iv.Prune(later); err != nil {
		t.Fatal(err)
	}
	again, err := LoadInvites(st)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		mint, want string
	}{{"burn", InviteBurned}, {"cancel", InviteCancelled}, {"expire", InviteExpired}} {
		got := StatusOf(s, again, "", c.mint, later)
		if got.State != c.want {
			t.Fatalf("after a restart, mint %s is %+v; want %s", c.mint, got, c.want)
		}
	}
	if got := StatusOf(s, again, lapsed.ID, "", later); got.MintID != "expire" {
		t.Fatalf("the expired entry lost its mintId: %+v", got)
	}
	var onDisk []Invite
	if _, err := st.ReadJSON("offers.json", &onDisk); err != nil || len(onDisk) != 3 {
		t.Fatalf("offers.json holds %d entries (%v); want 3", len(onDisk), err)
	}
	for _, x := range onDisk {
		if len(x.Secret) != 0 || x.ExpiresAt != 0 {
			t.Fatalf("terminal entry %+v keeps a secret or an expiry", x)
		}
	}
}

// After a reissue (cancel the first mint, make a second one for the same machine) a question about the second mint
// names the second invite, never the first one's cancelled entry.
func TestAReissuedMintIsFoundByItsOwnMintID(t *testing.T) {
	_, s, iv := joinFixture(t)
	now := time.UnixMilli(1_800_000_000_000)
	sub := subjectOf(detID(3), "j")
	first, err := iv.CreateBound(sub, "attach-1.1", now.Add(time.Minute), now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := iv.Cancel("", "attach-1.1", now); err != nil {
		t.Fatal(err)
	}
	if got := StatusOf(s, iv, "", "attach-1.2", now); got.State != InviteAbsent {
		t.Fatalf("the second mint before its create: %+v; want absent", got)
	}
	second, err := iv.CreateBound(sub, "attach-1.2", now.Add(time.Minute), now)
	if err != nil {
		t.Fatal(err)
	}
	got := StatusOf(s, iv, "", "attach-1.2", now)
	if got.State != InviteLive || got.InviteID != second.ID || got.InviteID == first.ID {
		t.Fatalf("second mint: %+v; want live invite %s", got, second.ID)
	}
}

// A mint that reaches the book after its expiresAt makes nothing.
func TestAMintPastItsExpiresAtMakesNothing(t *testing.T) {
	_, _, iv := joinFixture(t)
	now := time.UnixMilli(1_800_000_000_000)
	if _, err := iv.CreateBound(subjectOf(detID(3), "j"), "late", now, now); err == nil {
		t.Fatal("a mint at its expiresAt made an invite")
	}
	if x, ok := iv.findLocked("", "late"); ok {
		t.Fatalf("the refused mint left %+v", x)
	}
}

// Only the bound invite's nonce matches its subject's admit: another machine admitted through an ordinary invite at
// the same time is never reported as the bound invite's admission.
func TestOnlyTheBoundInvitesNonceMatchesItsSubjectsAdmit(t *testing.T) {
	f, s, iv := joinFixture(t)
	now := time.UnixMilli(1_800_000_000_000)
	j, k := detID(3), detID(4)
	ordinary, err := iv.Create(time.Minute, now)
	if err != nil {
		t.Fatal(err)
	}
	bound, err := iv.CreateBound(subjectOf(j, "j"), "m", now.Add(time.Minute), now)
	if err != nil {
		t.Fatal(err)
	}
	if serveErr, joinErr := serveOne(f, s, iv, ordinary.ID, now, k, "k"); serveErr != nil || joinErr != nil {
		t.Fatalf("ordinary join: %v, %v", serveErr, joinErr)
	}
	if serveErr, joinErr := serveOne(f, s, iv, bound.ID, now, j, "j"); serveErr != nil || joinErr != nil {
		t.Fatalf("bound join: %v, %v", serveErr, joinErr)
	}
	got := StatusOf(s, iv, bound.ID, "", now)
	if got.State != InviteBurned || got.Member == nil || !*got.Member {
		t.Fatalf("bound invite after its join: %+v; want burned with its subject a member", got)
	}
	admitted := map[string]string{}
	for _, r := range s.Records() {
		if r.B.Type == TypeAdmit {
			var cb CardBody
			if err := json.Unmarshal(r.B.Card.Body, &cb); err != nil {
				t.Fatal(err)
			}
			admitted[cb.Name] = r.Hash
		}
	}
	if got.Admit != admitted["j"] || got.Admit == admitted["k"] {
		t.Fatalf("admit %s; want j's %s, never k's %s", got.Admit, admitted["j"], admitted["k"])
	}
	if st := StatusOf(s, iv, ordinary.ID, "", now); st.State != InviteAbsent {
		t.Fatalf("the used ordinary invite: %+v; want absent (ordinary invites are not kept)", st)
	}
}

// invite.ack forgets a terminal entry or a fence once read, and refuses a live invite.
func TestAckForgetsSettledEntriesAndRefusesALiveOne(t *testing.T) {
	_, s, iv := joinFixture(t)
	now := time.UnixMilli(1_800_000_000_000)
	x, err := iv.CreateBound(subjectOf(detID(3), "j"), "m", now.Add(time.Minute), now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := iv.Ack(x.ID, "", now); err == nil {
		t.Fatal("a live invite was acknowledged")
	}
	iv.Cancel(x.ID, "", now)
	iv.Cancel("", "fence", now)
	for _, ref := range [][2]string{{x.ID, ""}, {"", "fence"}} {
		if got, err := iv.Ack(ref[0], ref[1], now); err != nil || got != "acked" {
			t.Fatalf("ack %v: %q, %v", ref, got, err)
		}
		if got := StatusOf(s, iv, ref[0], ref[1], now); got.State != InviteAbsent {
			t.Fatalf("after its ack %v is %+v", ref, got)
		}
	}
}

// A transition is one save: when offers.json cannot be written, a cancel or a burn of a bound invite changes nothing,
// and the invite stays usable.
func TestABoundTransitionThatCannotBeSavedChangesNothing(t *testing.T) {
	st := tmpState(t)
	iv, err := LoadInvites(st)
	if err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1_800_000_000_000)
	j := detID(3)
	x, err := iv.CreateBound(subjectOf(j, "j"), "m", now.Add(time.Minute), now)
	if err != nil {
		t.Fatal(err)
	}
	// A non-empty directory where offers.json was: the rename onto it fails, as root too.
	if err := os.Remove(st.Path("offers.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(st.Path("offers.json"), "x"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := iv.Cancel(x.ID, "", now); err == nil {
		t.Fatal("a cancel that could not be saved succeeded")
	}
	card := CardBody{SignPub: x.Subject.SignPub, NoisePub: x.Subject.NoisePub, Name: "j", Nonce: "n"}
	if err := iv.Burn(x.ID, now, card); err == nil {
		t.Fatal("a burn that could not be saved succeeded")
	}
	if _, ok := iv.Lookup(x.ID, now); !ok {
		t.Fatal("the invite is no longer usable after transitions that were not saved")
	}
}

// A burn whose admit could not be written to mesh.json reports burned-unsaved: the admit lives in memory only, and a
// restart before a later save would lose it.
func TestABurnWhoseAdmitIsNotSavedReportsBurnedUnsaved(t *testing.T) {
	st := tmpState(t)
	f, j := detID(1), detID(3)
	b, found := newMesh(t, f)
	s := NewStore(st, b.meshID)
	if _, err := s.Merge([]*Record{found}); err != nil {
		t.Fatal(err)
	}
	if err := s.Save(); err != nil {
		t.Fatal(err)
	}
	iv, err := LoadInvites(st)
	if err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1_800_000_000_000)
	x, err := iv.CreateBound(subjectOf(j, "j"), "m", now.Add(time.Minute), now)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(st.Path("mesh.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(st.Path("mesh.json"), "x"), 0o700); err != nil {
		t.Fatal(err)
	}
	serveOne(f, s, iv, x.ID, now, j, "j")
	if got := StatusOf(s, iv, x.ID, "", now); got.State != InviteBurnedUnsaved || got.Admit == "" {
		t.Fatalf("status %+v; want burned-unsaved naming the admit", got)
	}
}
