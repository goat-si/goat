package mesh

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
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
	inv, err := iv.CreateBound(subjectOf(j, "j"), "", now.Add(time.Minute), at(now))
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
	inv, err := iv.CreateBound(sub, "", now.Add(time.Minute), at(now))
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
		inv, err := iv.CreateBound(subjectOf(j, "j"), "", now.Add(time.Minute), at(now))
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
		state, err := iv.Cancel(inv.ID, "", at(now))
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
		inv, err := iv.CreateBound(subjectOf(j, "j"), "", now.Add(time.Minute), at(now))
		if err != nil {
			t.Fatal(err)
		}
		serveErr, joinErr := serveOne(f, s, iv, inv.ID, now, j, "j")
		state, err := iv.Cancel(inv.ID, "", at(now))
		if err != nil {
			t.Fatal(err)
		}
		check(t, s, state, serveErr, joinErr)
	})
	t.Run("concurrently", func(t *testing.T) {
		for range 16 {
			f, s, iv := joinFixture(t)
			inv, err := iv.CreateBound(subjectOf(j, "j"), "", now.Add(time.Minute), at(now))
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
			state, err := iv.Cancel(inv.ID, "", at(now))
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
	state, err := iv.Cancel("", "mint-1", at(now))
	if err != nil || state != InviteCancelled {
		t.Fatalf("cancel of an unmade mint: %q, %v; want cancelled", state, err)
	}
	again, err := LoadInvites(st)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := again.CreateBound(subjectOf(detID(3), "j"), "mint-1", now.Add(time.Minute), at(now)); !errors.Is(err, ErrMintCancelled) {
		t.Fatalf("create after the cancel (book reloaded): %v; want ErrMintCancelled", err)
	}
	var onDisk []Invite
	if _, err := st.ReadJSON("offers.json", &onDisk); err != nil || len(onDisk) != 1 || onDisk[0].ID != "" {
		t.Fatalf("offers.json %+v (%v); want only the fence", onDisk, err)
	}
	if _, err := again.CreateBound(subjectOf(detID(3), "j"), "mint-2", now.Add(time.Minute), at(now)); err != nil {
		t.Fatalf("another mint: %v", err)
	}
	if _, err := again.CreateBound(subjectOf(detID(3), "j"), "mint-2", now.Add(time.Minute), at(now)); !errors.Is(err, ErrMintUsed) {
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
		x, err := iv.CreateBound(subjectOf(j, "j"), m, now.Add(time.Minute), at(now))
		if err != nil {
			t.Fatal(err)
		}
		return x
	}
	burned, cancelled, lapsed := mint("burn"), mint("cancel"), mint("expire")
	if serveErr, joinErr := serveOne(f, s, iv, burned.ID, now, j, "j"); serveErr != nil || joinErr != nil {
		t.Fatalf("join: %v, %v", serveErr, joinErr)
	}
	if _, err := iv.Cancel(cancelled.ID, "", at(now)); err != nil {
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
		got := mustStatus(t, s, again, "", c.mint, at(later))
		if got.State != c.want {
			t.Fatalf("after a restart, mint %s is %+v; want %s", c.mint, got, c.want)
		}
	}
	if got := mustStatus(t, s, again, lapsed.ID, "", at(later)); got.MintID != "expire" {
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
	first, err := iv.CreateBound(sub, "attach-1.1", now.Add(time.Minute), at(now))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := iv.Cancel("", "attach-1.1", at(now)); err != nil {
		t.Fatal(err)
	}
	if got := mustStatus(t, s, iv, "", "attach-1.2", at(now)); got.State != InviteAbsent {
		t.Fatalf("the second mint before its create: %+v; want absent", got)
	}
	second, err := iv.CreateBound(sub, "attach-1.2", now.Add(time.Minute), at(now))
	if err != nil {
		t.Fatal(err)
	}
	got := mustStatus(t, s, iv, "", "attach-1.2", at(now))
	if got.State != InviteLive || got.InviteID != second.ID || got.InviteID == first.ID {
		t.Fatalf("second mint: %+v; want live invite %s", got, second.ID)
	}
}

// A mint that reaches the book after its expiresAt makes nothing.
func TestAMintPastItsExpiresAtMakesNothing(t *testing.T) {
	_, _, iv := joinFixture(t)
	now := time.UnixMilli(1_800_000_000_000)
	if _, err := iv.CreateBound(subjectOf(detID(3), "j"), "late", now, at(now)); err == nil {
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
	bound, err := iv.CreateBound(subjectOf(j, "j"), "m", now.Add(time.Minute), at(now))
	if err != nil {
		t.Fatal(err)
	}
	if serveErr, joinErr := serveOne(f, s, iv, ordinary.ID, now, k, "k"); serveErr != nil || joinErr != nil {
		t.Fatalf("ordinary join: %v, %v", serveErr, joinErr)
	}
	if serveErr, joinErr := serveOne(f, s, iv, bound.ID, now, j, "j"); serveErr != nil || joinErr != nil {
		t.Fatalf("bound join: %v, %v", serveErr, joinErr)
	}
	got := mustStatus(t, s, iv, bound.ID, "", at(now))
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
	if st := mustStatus(t, s, iv, ordinary.ID, "", at(now)); st.State != InviteAbsent {
		t.Fatalf("the used ordinary invite: %+v; want absent (ordinary invites are not kept)", st)
	}
}

// invite.ack forgets a terminal entry or a fence once read, and refuses a live invite.
func TestAckForgetsSettledEntriesAndRefusesALiveOne(t *testing.T) {
	_, s, iv := joinFixture(t)
	now := time.UnixMilli(1_800_000_000_000)
	x, err := iv.CreateBound(subjectOf(detID(3), "j"), "m", now.Add(time.Minute), at(now))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := iv.Ack(x.ID, "", at(now)); err == nil {
		t.Fatal("a live invite was acknowledged")
	}
	iv.Cancel(x.ID, "", at(now))
	iv.Cancel("", "fence", at(now))
	for _, ref := range [][2]string{{x.ID, ""}, {"", "fence"}} {
		if got, err := iv.Ack(ref[0], ref[1], at(now)); err != nil || got != "acked" {
			t.Fatalf("ack %v: %q, %v", ref, got, err)
		}
		if got := mustStatus(t, s, iv, ref[0], ref[1], at(now)); got.State != InviteAbsent {
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
	x, err := iv.CreateBound(subjectOf(j, "j"), "m", now.Add(time.Minute), at(now))
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
	if _, err := iv.Cancel(x.ID, "", at(now)); err == nil {
		t.Fatal("a cancel that could not be saved succeeded")
	}
	card := CardBody{SignPub: x.Subject.SignPub, NoisePub: x.Subject.NoisePub, Name: "j", Nonce: "n"}
	if err := iv.Burn(x.ID, now, card, at(now)); err == nil {
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
	x, err := iv.CreateBound(subjectOf(j, "j"), "m", now.Add(time.Minute), at(now))
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
	if got := mustStatus(t, s, iv, x.ID, "", at(now)); got.State != InviteBurnedUnsaved || got.Admit == "" {
		t.Fatalf("status %+v; want burned-unsaved naming the admit", got)
	}
}

// A reference naming neither an id nor a mintId names nothing: ordinary invites carry no mintId and are not matched.
func TestAnEmptyReferenceNamesNoInvite(t *testing.T) {
	_, s, iv := joinFixture(t)
	now := time.UnixMilli(1_800_000_000_000)
	x, err := iv.Create(time.Minute, now)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := iv.Cancel("", "", at(now)); err != nil || got != InviteAbsent {
		t.Fatalf("cancel of nothing: %q, %v; want absent", got, err)
	}
	if got := mustStatus(t, s, iv, "", "", at(now)); got.State != InviteAbsent {
		t.Fatalf("status of nothing: %+v; want absent", got)
	}
	if _, ok := iv.Lookup(x.ID, now); !ok {
		t.Fatal("the ordinary invite was cancelled by an empty reference")
	}
}

func at(t time.Time) func() time.Time { return func() time.Time { return t } }

func mustStatus(t *testing.T, s *Store, iv *Invites, id, mintID string, clock func() time.Time) InviteStatus {
	t.Helper()
	st, err := StatusOf(s, iv, id, mintID, clock)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	return st
}

// fakeClock is a clock a test moves while a join or a create waits.
type fakeClock struct {
	mu  sync.Mutex
	cur time.Time
}

func (c *fakeClock) now() time.Time  { c.mu.Lock(); defer c.mu.Unlock(); return c.cur }
func (c *fakeClock) set(t time.Time) { c.mu.Lock(); c.cur = t; c.mu.Unlock() }

// A bound invite that expires while its join waits before the burn is not burned: the burn reads the clock under
// the book's lock, not when the join began.
func TestABoundInviteThatExpiresBeforeItsBurnIsNotBurned(t *testing.T) {
	f, s, iv := joinFixture(t)
	now := time.UnixMilli(1_800_000_000_000)
	j := detID(3)
	inv, err := iv.CreateBound(subjectOf(j, "j"), "m", now.Add(time.Minute), at(now))
	if err != nil {
		t.Fatal(err)
	}
	clk := &fakeClock{cur: now}
	s.burnGate = func() { clk.set(now.Add(2 * time.Minute)) }
	srv, cli := pipe()
	served := make(chan error, 1)
	go func() {
		_, err := ServeJoin(context.Background(), srv, j.NoisePub, Admission{ID: f, Store: s, Invites: iv, InviteID: inv.ID, Now: clk.now})
		served <- err
	}()
	_, _, joinErr := Join(context.Background(), cli, j, "j")
	if serveErr := <-served; serveErr == nil || joinErr == nil || s.Len() != 1 {
		t.Fatalf("serve %v, join %v, records %d; want the expired invite refused and nothing signed", serveErr, joinErr, s.Len())
	}
	if got := mustStatus(t, s, iv, inv.ID, "", clk.now); got.State != InviteExpired {
		t.Fatalf("status %+v; want expired", got)
	}
}

// A create decides on the clock it reads under the book's lock, so a mint that waited for the lock past its expiresAt
// (or past the ack of its fence) makes nothing.
func TestACreateReadsItsClockUnderTheBooksLock(t *testing.T) {
	_, _, iv := joinFixture(t)
	now := time.UnixMilli(1_800_000_000_000)
	outside := false
	clock := func() time.Time {
		if iv.mu.TryLock() {
			iv.mu.Unlock()
			outside = true
		}
		return now
	}
	if _, err := iv.CreateBound(subjectOf(detID(3), "j"), "m", now.Add(time.Minute), clock); err != nil {
		t.Fatal(err)
	}
	if outside {
		t.Fatal("CreateBound read its clock without holding the book's lock")
	}
}

// Fences count toward the cap of 512 kept entries, so creates cannot push the book past it.
func TestFencesCountTowardTheCapOnCreates(t *testing.T) {
	_, _, iv := joinFixture(t)
	now := time.UnixMilli(1_800_000_000_000)
	for i := range maxBoundAndFences {
		if _, err := iv.Cancel("", fmt.Sprintf("f%d", i), at(now)); err != nil {
			t.Fatalf("fence %d: %v", i, err)
		}
	}
	if _, err := iv.CreateBound(subjectOf(detID(3), "j"), "m", now.Add(time.Minute), at(now)); err == nil {
		t.Fatal("a create succeeded with 512 entries kept")
	}
}

// joinWithCard answers the inviter's offer with a card j signs over the given key spellings and returns the joiner's
// error and the inviter's.
func joinWithCard(t *testing.T, f *ident.Identity, s *Store, iv *Invites, id string, now time.Time, j *ident.Identity, signPub, noisePub string) (joinErr, serveErr error) {
	t.Helper()
	srv, cliEnd := pipe()
	served := make(chan error, 1)
	go func() {
		_, err := ServeJoin(context.Background(), srv, j.NoisePub, Admission{ID: f, Store: s, Invites: iv, InviteID: id, Now: at(now)})
		served <- err
	}()
	c := &Lines{L: cliEnd}
	offer, err := c.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	cb := CardBody{V: 1, Mesh: offer.Mesh, Inviter: offer.Inviter, Nonce: offer.Nonce, NodeID: j.NodeID(), SignPub: signPub, NoisePub: noisePub, Name: "j"}
	body, err := json.Marshal(cb)
	if err != nil {
		t.Fatal(err)
	}
	card := &Card{Body: body, Sig: ed25519.Sign(j.SignPriv, digest(cardPrefix, body))}
	if err := card.Verify(); err != nil {
		t.Fatalf("the test's card does not verify: %v", err)
	}
	if err := c.Write(Msg{T: "card", Card: card}); err != nil {
		t.Fatal(err)
	}
	for {
		m, err := c.Read(context.Background())
		if err != nil {
			return err, <-served
		}
		if m.T == "refused" {
			return &RefusedError{Reason: m.Reason}, <-served
		}
		if m.T == "done" {
			return nil, <-served
		}
	}
}

// otherSpelling encodes the same 32-byte key with nonzero trailing bits, which base64url decoding accepts.
func otherSpelling(t *testing.T, k string) string {
	t.Helper()
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	i := strings.IndexByte(alphabet, k[len(k)-1])
	alt := k[:len(k)-1] + string(alphabet[i|1])
	if alt == k {
		alt = k[:len(k)-1] + string(alphabet[i|2])
	}
	if a, err := ident.DecodeKey(alt); err != nil || ident.B64.EncodeToString(a) != k {
		t.Fatalf("%s is not another spelling of %s (%v)", alt, k, err)
	}
	return alt
}

// The subject's keys must be spelled as the subject's canonical ones: a card spelling either key another way is
// refused before the burn (card keys key the member map, so it would be another member).
func TestABoundInviteRefusesAnotherSpellingOfItsSubjectsKeys(t *testing.T) {
	f, s, iv := joinFixture(t)
	now := time.UnixMilli(1_800_000_000_000)
	j := detID(3)
	sub := subjectOf(j, "j")
	inv, err := iv.CreateBound(sub, "", now.Add(time.Minute), at(now))
	if err != nil {
		t.Fatal(err)
	}
	for _, keys := range [][2]string{{otherSpelling(t, sub.SignPub), sub.NoisePub}, {sub.SignPub, otherSpelling(t, sub.NoisePub)}} {
		joinErr, serveErr := joinWithCard(t, f, s, iv, inv.ID, now, j, keys[0], keys[1])
		var refused *RefusedError
		if !errors.As(joinErr, &refused) || serveErr == nil {
			t.Fatalf("keys %v: join %v, serve %v; want a refusal", keys, joinErr, serveErr)
		}
		if _, ok := iv.Lookup(inv.ID, now); !ok || s.Len() != 1 {
			t.Fatalf("keys %v: invite usable %v, records %d; want it unburned and nothing signed", keys, ok, s.Len())
		}
	}
	if joinErr, serveErr := joinWithCard(t, f, s, iv, inv.ID, now, j, sub.SignPub, sub.NoisePub); joinErr != nil || serveErr != nil {
		t.Fatalf("canonical keys: join %v, serve %v", joinErr, serveErr)
	}
}

// An ordinary invite keeps its old rule: a join that passed its checks before the expiry and reached the burn after it
// is still admitted, judged at the time the join began.
func TestAnOrdinaryJoinDelayedAcrossItsExpiryIsStillAdmitted(t *testing.T) {
	f, s, iv := joinFixture(t)
	now := time.UnixMilli(1_800_000_000_000)
	j := detID(3)
	inv, err := iv.Create(time.Minute, now)
	if err != nil {
		t.Fatal(err)
	}
	clk := &fakeClock{cur: now}
	s.burnGate = func() { clk.set(now.Add(2 * time.Minute)) }
	srv, cli := pipe()
	served := make(chan error, 1)
	go func() {
		_, err := ServeJoin(context.Background(), srv, j.NoisePub, Admission{ID: f, Store: s, Invites: iv, InviteID: inv.ID, Now: clk.now})
		served <- err
	}()
	_, _, joinErr := Join(context.Background(), cli, j, "j")
	if serveErr := <-served; serveErr != nil || joinErr != nil || s.Len() != 2 {
		t.Fatalf("serve %v, join %v, records %d; want the ordinary join admitted as before", serveErr, joinErr, s.Len())
	}
}

// Cancel, ack and status decide on the clock they read under the book's lock, so one that waited for the lock past an
// expiry answers expired instead of cancelling or reporting live.
func TestCancelAckAndStatusReadTheirClockUnderTheBooksLock(t *testing.T) {
	_, s, iv := joinFixture(t)
	now := time.UnixMilli(1_800_000_000_000)
	outside := ""
	clockFor := func(what string) func() time.Time {
		return func() time.Time {
			if iv.mu.TryLock() {
				iv.mu.Unlock()
				outside = what
			}
			return now
		}
	}
	x, err := iv.CreateBound(subjectOf(detID(3), "j"), "m", now.Add(time.Minute), at(now))
	if err != nil {
		t.Fatal(err)
	}
	mustStatus(t, s, iv, x.ID, "", clockFor("status"))
	iv.Cancel(x.ID, "", clockFor("cancel"))
	iv.Ack(x.ID, "", clockFor("ack"))
	if outside != "" {
		t.Fatalf("%s read its clock without holding the book's lock", outside)
	}
}

// invite.status settles an expired bound invite before it answers expired, so a wall clock stepped back afterwards
// cannot make it live again.
func TestStatusSettlesAnExpiredBoundInvite(t *testing.T) {
	_, s, iv := joinFixture(t)
	now := time.UnixMilli(1_800_000_000_000)
	x, err := iv.CreateBound(subjectOf(detID(3), "j"), "m", now.Add(time.Minute), at(now))
	if err != nil {
		t.Fatal(err)
	}
	if got := mustStatus(t, s, iv, x.ID, "", at(now.Add(2*time.Minute))); got.State != InviteExpired {
		t.Fatalf("past its expiry: %+v", got)
	}
	back := now.Add(30 * time.Second)
	if got := mustStatus(t, s, iv, x.ID, "", at(back)); got.State != InviteExpired {
		t.Fatalf("after the clock went back: %+v; want still expired", got)
	}
	if _, ok := iv.Lookup(x.ID, back); ok {
		t.Fatal("the invite is usable again after the clock went back")
	}
}

// devInvite is an offers.json entry exactly as dev wrote it before bound invites.
type devInvite struct {
	ID        string `json:"id"`
	Secret    []byte `json:"secret"`
	ExpiresAt int64  `json:"expiresAt"`
}

// An ordinary invite's entry in offers.json is byte for byte what dev wrote: bound invites change nothing for it.
func TestAnOrdinaryInvitesEntryIsUnchanged(t *testing.T) {
	st := tmpState(t)
	iv, err := LoadInvites(st)
	if err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1_800_000_000_000)
	x, err := iv.Create(time.Minute, now)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.WriteJSON("dev.json", []devInvite{{ID: x.ID, Secret: x.Secret, ExpiresAt: x.ExpiresAt}}, 0o600); err != nil {
		t.Fatal(err)
	}
	got, err1 := os.ReadFile(st.Path("offers.json"))
	want, err2 := os.ReadFile(st.Path("dev.json"))
	if err1 != nil || err2 != nil || string(got) != string(want) {
		t.Fatalf("offers.json\n%s\nwant\n%s (%v, %v)", got, want, err1, err2)
	}
}

// After a downgrade a node older than bound invites reads offers.json with dev's struct: a live bound invite must look
// expired to it, with no secret, so it prunes the entry instead of admitting any machine with it. This node still uses it.
func TestALiveBoundInviteIsUnusableToAnOlderBinary(t *testing.T) {
	st := tmpState(t)
	iv, err := LoadInvites(st)
	if err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1_800_000_000_000)
	x, err := iv.CreateBound(subjectOf(detID(3), "j"), "m", now.Add(time.Minute), at(now))
	if err != nil {
		t.Fatal(err)
	}
	var old []devInvite
	if _, err := st.ReadJSON("offers.json", &old); err != nil || len(old) != 1 {
		t.Fatalf("offers.json as dev reads it: %+v (%v)", old, err)
	}
	if len(old[0].Secret) != 0 || old[0].ExpiresAt > now.UnixMilli() {
		t.Fatalf("dev's struct reads %+v; want no secret and an expiry already passed", old[0])
	}
	again, err := LoadInvites(st)
	if err != nil {
		t.Fatal(err)
	}
	if y, ok := again.Lookup(x.ID, now); !ok || string(y.Secret) != string(x.Secret) || y.ExpiresAt != x.ExpiresAt {
		t.Fatalf("reloaded %+v (found %v); want the live bound invite with its secret and expiry", y, ok)
	}
}

// When the settle of an expired bound invite cannot be saved, invite.status answers the error, never expired: the
// invite would still be live after a clock set back.
func TestStatusAnswersAnErrorWhenItCannotSettleAnExpiry(t *testing.T) {
	st := tmpState(t)
	_, s, _ := joinFixture(t)
	iv, err := LoadInvites(st)
	if err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1_800_000_000_000)
	x, err := iv.CreateBound(subjectOf(detID(3), "j"), "m", now.Add(time.Minute), at(now))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(st.Path("offers.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(st.Path("offers.json"), "x"), 0o700); err != nil {
		t.Fatal(err)
	}
	if got, err := StatusOf(s, iv, x.ID, "", at(now.Add(2*time.Minute))); err == nil {
		t.Fatalf("status %+v with no error; want the failed save reported", got)
	}
}

// A live bound entry in the earlier file form (secret and expiresAt beside the subject) still loads with its secret.
func TestABoundEntryInTheEarlierFileFormStillLoads(t *testing.T) {
	st := tmpState(t)
	now := time.UnixMilli(1_800_000_000_000)
	sub := subjectOf(detID(3), "j")
	old := []map[string]any{{"id": "AAAAAAAAAAAAAAAA", "secret": make([]byte, 32), "expiresAt": now.Add(time.Minute).UnixMilli(), "subject": sub, "mintId": "m"}}
	if err := st.WriteJSON("offers.json", old, 0o600); err != nil {
		t.Fatal(err)
	}
	iv, err := LoadInvites(st)
	if err != nil {
		t.Fatal(err)
	}
	if x, ok := iv.Lookup("AAAAAAAAAAAAAAAA", now); !ok || len(x.Secret) != 32 || x.Subject == nil {
		t.Fatalf("loaded %+v (found %v); want the live bound invite with its secret", x, ok)
	}
}

// A bound invite's cancel signal belongs to that invite alone: a cancel closes exactly its channel, a later invite made
// with the same mintId after an ack has its own, and a burn closes none.
func TestACancelSignalsOnlyItsOwnInvite(t *testing.T) {
	f, s, iv := joinFixture(t)
	now := time.UnixMilli(1_800_000_000_000)
	j := detID(3)
	closed := func(sig *Signals) bool {
		select {
		case <-sig.Cancelled:
			return true
		default:
			return false
		}
	}
	first, second, burned := NewSignals(), NewSignals(), NewSignals()
	x, err := iv.CreateBoundNotify(subjectOf(j, "j"), "m", now.Add(time.Minute), at(now), first)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := iv.CreateBoundNotify(subjectOf(j, "j"), "m", now.Add(time.Minute), at(now), second); !errors.Is(err, ErrMintUsed) {
		t.Fatalf("a second create with the same mintId: %v", err)
	}
	iv.Cancel("", "m", at(now))
	if !closed(first) || closed(second) {
		t.Fatalf("after the cancel: first closed %v, second closed %v; want only the first", closed(first), closed(second))
	}
	if _, err := iv.Ack(x.ID, "", at(now)); err != nil {
		t.Fatal(err)
	}
	y, err := iv.CreateBoundNotify(subjectOf(j, "j"), "m", now.Add(time.Minute), at(now), second)
	if err != nil {
		t.Fatal(err)
	}
	if closed(second) {
		t.Fatal("the reused mintId's invite is signalled before any cancel")
	}
	z, err := iv.CreateBoundNotify(subjectOf(j, "j"), "b", now.Add(time.Minute), at(now), burned)
	if err != nil {
		t.Fatal(err)
	}
	if serveErr, joinErr := serveOne(f, s, iv, z.ID, now, j, "j"); serveErr != nil || joinErr != nil {
		t.Fatalf("join: %v, %v", serveErr, joinErr)
	}
	if closed(burned) || closed(second) {
		t.Fatal("a burn signalled a cancel")
	}
	iv.Cancel(y.ID, "", at(now))
	if !closed(second) {
		t.Fatal("the reused mintId's invite was not signalled by its own cancel")
	}
}

// A bound entry read in #3117's file form is rewritten when the book loads, so a node downgraded before any later
// save never finds its secret under the members it reads.
func TestLoadingRewritesABoundEntryInTheEarlierFileForm(t *testing.T) {
	st := tmpState(t)
	now := time.UnixMilli(1_800_000_000_000)
	sub := subjectOf(detID(3), "j")
	old := []map[string]any{{"id": "AAAAAAAAAAAAAAAA", "secret": make([]byte, 32), "expiresAt": now.Add(time.Minute).UnixMilli(), "subject": sub, "mintId": "m"}}
	if err := st.WriteJSON("offers.json", old, 0o600); err != nil {
		t.Fatal(err)
	}
	iv, err := LoadInvites(st)
	if err != nil {
		t.Fatal(err)
	}
	var dev []devInvite
	if _, err := st.ReadJSON("offers.json", &dev); err != nil || len(dev) != 1 {
		t.Fatalf("offers.json as dev reads it: %+v (%v)", dev, err)
	}
	if len(dev[0].Secret) != 0 || dev[0].ExpiresAt != 0 {
		t.Fatalf("after loading, dev's struct still reads %+v; want no secret and no expiry", dev[0])
	}
	// This node still has the invite, before and after reading the rewritten file again.
	again, err := LoadInvites(st)
	if err != nil {
		t.Fatal(err)
	}
	for _, book := range []*Invites{iv, again} {
		if x, ok := book.Lookup("AAAAAAAAAAAAAAAA", now); !ok || len(x.Secret) != 32 || x.ExpiresAt != now.Add(time.Minute).UnixMilli() {
			t.Fatalf("lookup %+v (found %v); want the live invite with its 32-byte secret and expiry", x, ok)
		}
	}
}

// recordsFail is a Link whose sends fail once the inviter starts sending the record set: the admit is signed and
// stored, and the joiner never receives it.
type recordsFail struct{ Link }

func (l recordsFail) Send(p []byte) error {
	if bytes.Contains(p, []byte(`"t":"records"`)) {
		l.Link.Close(4400)
		return errors.New("send failed after the admit")
	}
	return l.Link.Send(p)
}

// A join that fails after its burn committed says so and names the joiner it admitted: the invite admits nobody
// else, and a caller waiting on it must not be told it expired.
func TestAJoinThatFailsAfterItsBurnNamesWhomItAdmitted(t *testing.T) {
	f, s, iv := joinFixture(t)
	now := time.UnixMilli(1_800_000_000_000)
	j := detID(3)
	inv, err := iv.CreateBound(subjectOf(j, "j"), "m", now.Add(time.Minute), at(now))
	if err != nil {
		t.Fatal(err)
	}
	srv, cli := pipe()
	served := make(chan error, 1)
	go func() {
		_, err := ServeJoin(context.Background(), recordsFail{srv}, j.NoisePub, Admission{ID: f, Store: s, Invites: iv, InviteID: inv.ID, Now: at(now)})
		served <- err
	}()
	Join(context.Background(), cli, j, "j")
	serveErr := <-served
	var burned *BurnedError
	if !errors.As(serveErr, &burned) || burned.Member == nil || burned.Member.SignPub != pub(j) {
		t.Fatalf("serve %v; want a BurnedError naming the joiner", serveErr)
	}
	if got := mustStatus(t, s, iv, inv.ID, "", at(now)); got.State != InviteBurned || got.Member == nil || !*got.Member {
		t.Fatalf("status %+v; want burned with the joiner a member", got)
	}
}

// When mesh.json cannot be written after the admit is stored, the join fails, yet the joiner is a member of this
// node's view: the failure names it.
func TestAJoinWhoseAdmitIsNotSavedNamesWhomItAdmitted(t *testing.T) {
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
	x, err := iv.CreateBound(subjectOf(j, "j"), "m", now.Add(time.Minute), at(now))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(st.Path("mesh.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(st.Path("mesh.json"), "x"), 0o700); err != nil {
		t.Fatal(err)
	}
	serveErr, _ := serveOne(f, s, iv, x.ID, now, j, "j")
	var burned *BurnedError
	if !errors.As(serveErr, &burned) || burned.Member == nil || burned.Member.SignPub != pub(j) {
		t.Fatalf("serve %v; want a BurnedError naming the joiner", serveErr)
	}
}

// An ordinary invite that a failed burn left out of memory but live in offers.json is not reported expired by a
// wait unless the book is written first: a failed write is an error, never expired.
func TestAWaitDoesNotCallAnUnwrittenRemovalExpired(t *testing.T) {
	st := tmpState(t)
	iv, err := LoadInvites(st)
	if err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1_800_000_000_000)
	sig := NewSignals()
	x, err := iv.CreateNotify(time.Minute, now, sig)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(st.Path("offers.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(st.Path("offers.json"), "x"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := iv.Burn(x.ID, now, CardBody{}, at(now)); err == nil {
		t.Fatal("a burn that could not be saved succeeded")
	}
	if state, _, err := iv.WaitExpiry(x.ID, sig, at(now.Add(2*time.Minute))); err == nil {
		t.Fatalf("wait expiry answered %q with no error; want the failed write reported", state)
	}
}
