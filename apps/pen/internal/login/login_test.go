package login_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/login"
	"github.com/goat-si/goat/apps/pen/internal/logintest"
)

func fake(t *testing.T) *logintest.Server {
	s := logintest.New()
	s.MinPoll = 0
	s.Start()
	t.Cleanup(s.Close)
	return s
}

func client(s *logintest.Server) *login.Client {
	c := login.New(s.URL)
	c.After = func(time.Duration) <-chan time.Time {
		ch := make(chan time.Time, 1)
		ch <- time.Time{}
		return ch
	}
	return c
}

func newID(t *testing.T) *ident.Identity {
	id, err := ident.Generate(nil)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

var alice = login.Account{Sub: "1001", Email: "alice@example.com"}

func signIn(t *testing.T, s *logintest.Server, id *ident.Identity, name string) *login.Token {
	t.Helper()
	ctx := context.Background()
	c := client(s)
	st, err := c.Start(ctx, id, name)
	if err != nil {
		t.Fatal(err)
	}
	if !s.Approve(st.UserCode, alice) {
		t.Fatalf("code %s not pending", st.UserCode)
	}
	tok, err := c.Wait(ctx, id, st)
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func TestDeviceFlowYieldsAnAssertionForThisNodeOnce(t *testing.T) {
	s := fake(t)
	id := newID(t)
	tok := signIn(t, s, id, "laptop")
	if tok.Account != alice || tok.Mesh != nil || !tok.Assertion.ForKeys(id.SignPub, id.NoisePub) {
		t.Fatalf("token %+v", tok)
	}
	if err := tok.Assertion.Check(login.Binding{LoginURL: s.URL, Key: tok.LoginKey, Sub: alice.Sub}, time.Now()); err != nil {
		t.Fatal(err)
	}
}

func TestDeniedSignInEndsTheFlow(t *testing.T) {
	s := fake(t)
	id := newID(t)
	c := client(s)
	st, err := c.Start(context.Background(), id, "laptop")
	if err != nil {
		t.Fatal(err)
	}
	s.Deny(st.UserCode)
	if _, err := c.Wait(context.Background(), id, st); !errors.Is(err, login.ErrDenied) {
		t.Fatalf("got %v, want denied", err)
	}
}

func TestPollingFasterThanTheIntervalIsSlowDown(t *testing.T) {
	s := fake(t)
	s.MinPoll = time.Hour
	id := newID(t)
	c := client(s)
	st, _ := c.Start(context.Background(), id, "laptop")
	if _, slow, err := c.Poll(context.Background(), id, st.DeviceCode); slow || err != nil {
		t.Fatalf("first poll: slow %v err %v", slow, err)
	}
	if _, slow, _ := c.Poll(context.Background(), id, st.DeviceCode); !slow {
		t.Fatal("second poll within the interval was not slow_down")
	}
}

func TestRegistryKeepsTheFirstMeshAndRefusesAnother(t *testing.T) {
	s := fake(t)
	ctx := context.Background()
	a, b := newID(t), newID(t)
	ta, tb := signIn(t, s, a, "a"), signIn(t, s, b, "b")
	c := client(s)
	if err := c.Register(ctx, a, ta.Assertion, "mesh-one"); err != nil {
		t.Fatal(err)
	}
	if err := c.Register(ctx, a, tb.Assertion, "mesh-one"); err == nil {
		t.Fatal("a node registered with another node's assertion")
	}
	if err := c.Register(ctx, b, tb.Assertion, "mesh-two"); !errors.Is(err, login.ErrOtherMesh) {
		t.Fatalf("another mesh: %v, want 409", err)
	}
	if err := c.Register(ctx, b, tb.Assertion, "mesh-one"); err != nil {
		t.Fatal(err)
	}
	// An assertion registers at most once, even after a reset.
	s.Reset(alice.Sub)
	if err := c.Register(ctx, a, ta.Assertion, "mesh-three"); err == nil {
		t.Fatal("a used assertion registered again after a reset")
	}
}

func TestForgetBySameAccountNodeRemovesAndOutsiderIsRefused(t *testing.T) {
	s := fake(t)
	ctx := context.Background()
	a, b, outsider := newID(t), newID(t), newID(t)
	c := client(s)
	for _, x := range []*ident.Identity{a, b} {
		if err := c.Register(ctx, x, signIn(t, s, x, "n").Assertion, "m"); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.Forget(ctx, outsider, b.NodeID(), time.Now()); err == nil {
		t.Fatal("a key outside the account forgot a node")
	}
	if err := c.Forget(ctx, a, b.NodeID(), time.Now().Add(-3*time.Minute)); err == nil {
		t.Fatal("a stale ts was accepted")
	}
	if err := c.Forget(ctx, a, b.NodeID(), time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, nodes := s.Registry(alice.Sub); len(nodes) != 1 || nodes[0].NodeID != a.NodeID() {
		t.Fatalf("registry %v", nodes)
	}
}

func TestMemberCheckRefusesWrongAccountKeyServiceAndTime(t *testing.T) {
	s := fake(t)
	id := newID(t)
	now := time.Now()
	good := login.Binding{LoginURL: s.URL, Key: s.Key(), Sub: alice.Sub}
	a := s.Issue(alice.Sub, alice.Email, id.SignPub, id.NoisePub, now)
	if err := a.Check(good, now); err != nil {
		t.Fatal(err)
	}
	other := good
	other.Sub = "2002"
	if a.Check(other, now) == nil {
		t.Fatal("wrong sub accepted")
	}
	other = good
	other.LoginURL = "https://elsewhere.example"
	if a.Check(other, now) == nil {
		t.Fatal("wrong iss accepted")
	}
	other = good
	other.Key = s.Rotate()
	if a.Check(other, now) == nil {
		t.Fatal("assertion under another login key accepted")
	}
	if err := a.Check(good, now.Add(login.AssertionLifetime+login.Skew)); !errors.Is(err, login.ErrClockSkew) {
		t.Fatalf("expired: %v, want a clock skew refusal", err)
	}
	if err := a.Check(good, now.Add(-login.Skew-time.Second)); !errors.Is(err, login.ErrClockSkew) {
		t.Fatalf("issued in the future: %v, want a clock skew refusal", err)
	}
	a.Body[len(a.Body)-2] ^= 1
	if a.Check(good, now) == nil {
		t.Fatal("tampered body accepted")
	}
}
