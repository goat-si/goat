package daemon

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/login"
	"github.com/goat-si/goat/apps/pen/internal/logintest"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/session"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

const testSub = "1001"

func loginFake(t *testing.T) *logintest.Server {
	s := logintest.New()
	s.MinPoll = 0
	s.Start()
	t.Cleanup(s.Close)
	return s
}

func bindTo(t *testing.T, n *node, f *logintest.Server, key login.Key) {
	t.Helper()
	var r map[string]any
	acct := &mesh.Account{LoginURL: f.URL, LoginKey: mesh.LoginKey(key), Sub: testSub}
	if err := Call(n.st, Request{Op: "login-bind", Account: acct}, &r); err != nil {
		t.Fatal(err)
	}
}

func offeredBy(t *testing.T, ns ...*node) []login.OfferedMember {
	var out []login.OfferedMember
	for _, n := range ns {
		self := n.ls(t)
		for _, m := range self.Members {
			if m.Self {
				out = append(out, login.OfferedMember{NodeID: m.NodeID, SignPub: m.SignPub, NoisePub: m.NoisePub, Name: m.Name})
			}
		}
	}
	return out
}

// newcomer is a fresh identity that has not joined anything.
func newcomer(t *testing.T) *ident.Identity {
	id, err := ident.Generate(nil)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func refusal(t *testing.T, err error) string {
	t.Helper()
	var r *mesh.RefusedError
	if !errors.As(err, &r) {
		t.Fatalf("got %v, want a refusal", err)
	}
	return r.Reason
}

func TestAccountJoinInAutoModeAdmitsViaGoogleAndBothViewsShowIt(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := loginFake(t)
	a := founder(t, ctx, rs, "a", nil)
	bindTo(t, a, f, f.Key())
	b := newcomer(t)
	as := f.Issue(testSub, "me@example.com", b.SignPub, b.NoisePub, time.Now())
	out, by, err := AccountJoin(ctx, []string{rs.URL}, b, "b", as, offeredBy(t, a))
	if err != nil {
		t.Fatal(err)
	}
	if out.QueuedID != "" || by.Name != "a" {
		t.Fatalf("outcome %+v by %s", out, by.Name)
	}
	s, err := mesh.CheckJoined(nil, b, out.MeshID, out.Records)
	if err != nil {
		t.Fatal(err)
	}
	m := s.View().Members[ident.B64.EncodeToString(b.SignPub)]
	if m.Via != mesh.ViaGoogle || m.Email != "me@example.com" {
		t.Fatalf("joiner's own view: %+v", m)
	}
	for _, lm := range a.ls(t).Members {
		if lm.Name == "b" && (lm.Via != mesh.ViaGoogle || lm.Email != "me@example.com") {
			t.Fatalf("member's view: %+v", lm)
		}
	}
}

func TestAccountJoinRefusesAWrongAccountKeyTimeOrAnotherNodesAssertion(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := loginFake(t)
	a := founder(t, ctx, rs, "a", nil)
	bindTo(t, a, f, f.Key())
	b, other := newcomer(t), newcomer(t)
	_, stranger, _ := ed25519.GenerateKey(rand.Reader)
	foreign, _ := login.Issue(stranger, f.URL, testSub, "me@example.com", b.SignPub, b.NoisePub, time.Now())
	cases := map[string]struct {
		a    *login.Assertion
		want string
	}{
		"wrong sub":             {f.Issue("2002", "x@example.com", b.SignPub, b.NoisePub, time.Now()), "another Google account"},
		"wrong login key":       {foreign, "not signed by this login key"},
		"expired":               {f.Issue(testSub, "me@example.com", b.SignPub, b.NoisePub, time.Now().Add(-12*time.Minute)), "clock skew"},
		"another node's keys":   {f.Issue(testSub, "me@example.com", other.SignPub, b.NoisePub, time.Now()), "not the assertion's"},
		"another session's key": {f.Issue(testSub, "me@example.com", b.SignPub, other.NoisePub, time.Now()), "not for this session's key"},
	}
	for name, c := range cases {
		_, _, err := AccountJoin(ctx, []string{rs.URL}, b, "b", c.a, offeredBy(t, a))
		if got := refusal(t, err); !strings.Contains(got, c.want) {
			t.Fatalf("%s: refused %q, want %q", name, got, c.want)
		}
	}
	if n := len(a.ls(t).Members); n != 1 {
		t.Fatalf("%d members after refusals", n)
	}
}

func TestALockedMeshQueuesTheRequestThenApproveAdmitsAndTheJoinerSyncs(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := loginFake(t)
	a := founder(t, ctx, rs, "a", nil)
	bindTo(t, a, f, f.Key())
	var lr map[string]any
	if err := Call(a.st, Request{Op: "lock", On: true}, &lr); err != nil || lr["locked"] != true {
		t.Fatalf("lock: %v %v", lr, err)
	}
	b := newcomer(t)
	as := f.Issue(testSub, "me@example.com", b.SignPub, b.NoisePub, time.Now())
	out, by, err := AccountJoin(ctx, []string{rs.URL}, b, "b", as, offeredBy(t, a))
	if err != nil {
		t.Fatal(err)
	}
	fp := ident.Fingerprint(b.NoisePub)
	if out.QueuedID != fp[:9] || out.QueuedBy != "a" || len(a.ls(t).Members) != 1 {
		t.Fatalf("outcome %+v, want queued as %q on a", out, fp[:9])
	}
	if _, err := SyncApproved(ctx, []string{rs.URL}, b, by, out.MeshID); !errors.Is(err, ErrNotApproved) {
		t.Fatalf("sync before approval: %v, want not approved", err)
	}
	var ar ApproveResult
	if err := Call(a.st, Request{Op: "approve", Subject: fp}, &ar); err != nil {
		t.Fatal(err)
	}
	if ar.Member.Name != "b" || ar.Member.Via != mesh.ViaGoogle {
		t.Fatalf("approved %+v", ar.Member)
	}
	s, err := SyncApproved(ctx, []string{rs.URL}, b, by, out.MeshID)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.View().Members) != 2 || !s.View().Locked {
		t.Fatalf("joiner's view: %d members, locked %v", len(s.View().Members), s.View().Locked)
	}
}

func TestDenyDropsTheRequestAndRefusesTheKeyFor24Hours(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := loginFake(t)
	a := founder(t, ctx, rs, "a", nil)
	bindTo(t, a, f, f.Key())
	var lr map[string]any
	Call(a.st, Request{Op: "lock", On: true}, &lr)
	b := newcomer(t)
	as := f.Issue(testSub, "me@example.com", b.SignPub, b.NoisePub, time.Now())
	out, by, err := AccountJoin(ctx, []string{rs.URL}, b, "b", as, offeredBy(t, a))
	if err != nil {
		t.Fatal(err)
	}
	var dr map[string]any
	if err := Call(a.st, Request{Op: "deny", Subject: out.QueuedID}, &dr); err != nil {
		t.Fatal(err)
	}
	var pr struct{ Pending []Pending }
	if Call(a.st, Request{Op: "pending"}, &pr); len(pr.Pending) != 0 {
		t.Fatalf("pending after deny: %+v", pr.Pending)
	}
	if _, err := SyncApproved(ctx, []string{rs.URL}, b, by, out.MeshID); !errors.Is(err, ErrNotApproved) {
		t.Fatalf("denied key synced: %v", err)
	}
	_, _, err = AccountJoin(ctx, []string{rs.URL}, b, "b", as, offeredBy(t, a))
	if got := refusal(t, err); !strings.Contains(got, "denied") {
		t.Fatalf("asking again: %q, want denied", got)
	}
}

func openAccount(t *testing.T, ctx context.Context, rs *relaytest.Server, to *node) *session.Secure {
	t.Helper()
	id := newcomer(t)
	sec, err := OpenAny(ctx, []string{rs.URL}, to.id.NodeID(), func(conn relay.Conn) (*session.Secure, error) {
		return session.Initiate(ctx, conn, session.KindAccount, to.id.NodeID(), to.id.NoisePub, id, nil, session.Payload{V: 1, Stream: "account", Name: "x"})
	})
	if err != nil {
		t.Fatal(err)
	}
	return sec
}

func TestAFifthAccountSessionEvictsTheOldestThatSentNoAssertion(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	var open []*session.Secure
	for range MaxAccountSessions + 1 {
		open = append(open, openAccount(t, ctx, rs, a))
	}
	if _, err := open[0].Recv(ctx); relay.CodeOf(err) != wire.CodeCaps {
		t.Fatalf("oldest session: %v, want 4429", err)
	}
}

func TestAnAccountJoinerThatSendsNoAssertionIsClosed4408(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	st := shortDir(t)
	id := identity(t, st, rs.URL, "a")
	if _, err := mesh.Found(st, id, "a", 1); err != nil {
		t.Fatal(err)
	}
	a := startWith(t, ctx, rs, st, func(o *Options) { o.AccountWait = 50 * time.Millisecond })
	sec := openAccount(t, ctx, rs, a)
	if _, err := sec.Recv(ctx); relay.CodeOf(err) != wire.CodeTimeout {
		t.Fatalf("silent joiner: %v, want 4408", err)
	}
}

func TestRebindingToARotatedLoginKeyRefusesAssertionsUnderTheOldKey(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := loginFake(t)
	a := founder(t, ctx, rs, "a", nil)
	bindTo(t, a, f, f.Key())
	b, c := newcomer(t), newcomer(t)
	old := f.Issue(testSub, "me@example.com", b.SignPub, b.NoisePub, time.Now())
	bindTo(t, a, f, f.Rotate())
	_, _, err := AccountJoin(ctx, []string{rs.URL}, b, "b", old, offeredBy(t, a))
	if got := refusal(t, err); !strings.Contains(got, "not signed by this login key") {
		t.Fatalf("old key after rotation: %q", got)
	}
	fresh := f.Issue(testSub, "me@example.com", c.SignPub, c.NoisePub, time.Now())
	if _, _, err := AccountJoin(ctx, []string{rs.URL}, c, "c", fresh, offeredBy(t, a)); err != nil {
		t.Fatalf("new key after rotation: %v", err)
	}
}

func TestBindWaitsUntilEveryMemberAnnouncesPen11(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := loginFake(t)
	a := founder(t, ctx, rs, "a", nil)
	st := shortDir(t)
	tok := a.invite(t, time.Minute)
	id := identity(t, st, tok.Relays[0], "b")
	s, err := Join(ctx, st, id, tok, "b")
	if err != nil {
		t.Fatal(err)
	}
	s.Save()
	var r map[string]any
	acct := &mesh.Account{LoginURL: f.URL, LoginKey: mesh.LoginKey(f.Key()), Sub: testSub}
	if err := Call(a.st, Request{Op: "login-bind", Account: acct}, &r); err == nil || !strings.Contains(err.Error(), "b") {
		t.Fatalf("bind with b never heard from: %v, want a refusal naming b", err)
	}
	start(t, ctx, rs, st, nil)
	if err := Call(a.st, Request{Op: "login-bind", Account: acct}, &r); err != nil {
		t.Fatalf("bind once b announced 1.1: %v", err)
	}
}

func TestRevokingARegisteredMemberForgetsItAtTheLoginService(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := loginFake(t)
	a := founder(t, ctx, rs, "a", nil)
	bindTo(t, a, f, f.Key())
	b := newcomer(t)
	as := f.Issue(testSub, "me@example.com", b.SignPub, b.NoisePub, time.Now())
	out, _, err := AccountJoin(ctx, []string{rs.URL}, b, "b", as, offeredBy(t, a))
	if err != nil {
		t.Fatal(err)
	}
	cl := login.New(f.URL)
	if err := cl.Register(ctx, b, as, out.MeshID); err != nil {
		t.Fatal(err)
	}
	// The founder registered when it bound the mesh; only a node under the account may forget another.
	if err := cl.Register(ctx, a.id, f.Issue(testSub, "me@example.com", a.id.SignPub, a.id.NoisePub, time.Now()), out.MeshID); err != nil {
		t.Fatal(err)
	}
	var r map[string]any
	if err := Call(a.st, Request{Op: "revoke", Subject: ident.B64.EncodeToString(b.SignPub)}, &r); err != nil {
		t.Fatal(err)
	}
	if got := <-f.Forgotten(); got != b.NodeID() {
		t.Fatalf("forgot %s, want %s", got, b.NodeID())
	}
}

func TestALeavingMemberForgetsItselfAtTheLoginService(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := loginFake(t)
	a := founder(t, ctx, rs, "a", nil)
	bindTo(t, a, f, f.Key())
	st := shortDir(t)
	bid := identity(t, st, rs.URL, "b")
	as := f.Issue(testSub, "me@example.com", bid.SignPub, bid.NoisePub, time.Now())
	out, _, err := AccountJoin(ctx, []string{rs.URL}, bid, "b", as, offeredBy(t, a))
	if err != nil {
		t.Fatal(err)
	}
	// Only b is registered, so only b's own forget can succeed.
	if err := login.New(f.URL).Register(ctx, bid, as, out.MeshID); err != nil {
		t.Fatal(err)
	}
	s, err := mesh.CheckJoined(st, bid, out.MeshID, out.Records)
	if err != nil {
		t.Fatal(err)
	}
	s.Save()
	b := start(t, ctx, rs, st, nil)
	var res struct{ Results []PushResult }
	if err := Call(b.st, Request{Op: "leave"}, &res); err != nil {
		t.Fatal(err)
	}
	if got := <-f.Forgotten(); got != bid.NodeID() {
		t.Fatalf("forgot %s, want the leaving node %s", got, bid.NodeID())
	}
}

func TestLockWaitsUntilEveryMemberAnnouncesPen11(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	st := shortDir(t)
	tok := a.invite(t, time.Minute)
	id := identity(t, st, tok.Relays[0], "old")
	s, err := Join(ctx, st, id, tok, "old")
	if err != nil {
		t.Fatal(err)
	}
	s.Save()
	startWith(t, ctx, rs, st, func(o *Options) { o.Announce = "-" }) // a v1.0 node
	var r map[string]any
	if err := Call(a.st, Request{Op: "lock", On: true}, &r); err == nil || !strings.Contains(err.Error(), "old") {
		t.Fatalf("lock with a v1.0 member: %v, want a refusal naming old", err)
	}
	if a.ls(t).Locked {
		t.Fatal("a lock record was signed while a member runs v1.0")
	}
}

func TestAVersionAnnouncedInAnEarlierSyncDoesNotCountAfterTheMemberDowngrades(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	var r map[string]any
	if err := Call(a.st, Request{Op: "lock", On: true}, &r); err != nil {
		t.Fatalf("lock with every member on 1.1: %v", err)
	}
	if err := Call(a.st, Request{Op: "lock", On: false}, &r); err != nil {
		t.Fatal(err)
	}
	b.d.Stop()
	if err := <-b.done; err != nil {
		t.Fatal(err)
	}
	b.done <- nil
	startWith(t, ctx, rs, b.st, func(o *Options) { o.Announce = "-" })
	if err := Call(a.st, Request{Op: "lock", On: true}, &r); err == nil || !strings.Contains(err.Error(), "b") {
		t.Fatalf("lock after b came back as v1.0: %v, want a refusal naming b", err)
	}
}

// toOffer plays an account joiner up to the member's offer; the caller sends the card when it chooses.
func toOffer(t *testing.T, ctx context.Context, rs *relaytest.Server, to *node, id *ident.Identity, as *login.Assertion) (*mesh.Lines, *mesh.Msg) {
	t.Helper()
	sec, err := OpenAny(ctx, []string{rs.URL}, to.id.NodeID(), func(conn relay.Conn) (*session.Secure, error) {
		return session.Initiate(ctx, conn, session.KindAccount, to.id.NodeID(), to.id.NoisePub, id, nil, session.Payload{V: 1, Stream: "account", Name: "j"})
	})
	if err != nil {
		t.Fatal(err)
	}
	c := &mesh.Lines{L: sec}
	raw, _ := json.Marshal(as)
	if err := c.Write(mesh.Msg{T: "assertion", Assertion: raw}); err != nil {
		t.Fatal(err)
	}
	m, err := c.Read(ctx)
	if err != nil || m.T != "offer" {
		t.Fatalf("got %+v %v, want an offer", m, err)
	}
	return c, m
}

func sendCard(t *testing.T, ctx context.Context, c *mesh.Lines, id *ident.Identity, offer *mesh.Msg) *mesh.Msg {
	t.Helper()
	card, err := mesh.MakeCard(id, offer.Mesh, offer.Inviter, offer.Nonce, "j")
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Write(mesh.Msg{T: "card", Card: card}); err != nil {
		t.Fatal(err)
	}
	m, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("after the card: %v", err)
	}
	return m
}

func TestAnUnbindDuringTheCardWaitRefusesTheJoinerWithoutACrash(t *testing.T) {
	for _, locked := range []bool{true, false} {
		ctx, cancel := context.WithCancel(context.Background())
		rs := relaytest.New()
		f := loginFake(t)
		a := founder(t, ctx, rs, "a", nil)
		bindTo(t, a, f, f.Key())
		var r map[string]any
		if locked {
			Call(a.st, Request{Op: "lock", On: true}, &r)
		}
		j := newcomer(t)
		c, offer := toOffer(t, ctx, rs, a, j, f.Issue(testSub, "me@example.com", j.SignPub, j.NoisePub, time.Now()))
		if err := Call(a.st, Request{Op: "account-unbind"}, &r); err != nil {
			t.Fatal(err)
		}
		if m := sendCard(t, ctx, c, j, offer); m.T != "refused" {
			t.Fatalf("locked %v: after an unbind the card got %q, want refused", locked, m.T)
		}
		if n := len(a.ls(t).Members); n != 1 {
			t.Fatalf("locked %v: %d members", locked, n)
		}
		cancel()
		rs.Close()
	}
}

func TestARebindToAnotherAccountDuringTheCardWaitRefusesTheJoiner(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := loginFake(t)
	a := founder(t, ctx, rs, "a", nil)
	bindTo(t, a, f, f.Key())
	j := newcomer(t)
	c, offer := toOffer(t, ctx, rs, a, j, f.Issue(testSub, "me@example.com", j.SignPub, j.NoisePub, time.Now()))
	var r map[string]any
	other := &mesh.Account{LoginURL: f.URL, LoginKey: mesh.LoginKey(f.Key()), Sub: "2002"}
	if err := Call(a.st, Request{Op: "login-bind", Account: other}, &r); err != nil {
		t.Fatal(err)
	}
	if m := sendCard(t, ctx, c, j, offer); m.T != "refused" || !strings.Contains(m.Reason, "another Google account") {
		t.Fatalf("after a rebind to another account the card got %+v, want refused", m)
	}
}

func TestAForgetTheServiceDidNotAnswerIsKeptAndSentAfterARestart(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := loginFake(t)
	a := founder(t, ctx, rs, "a", nil)
	bindTo(t, a, f, f.Key())
	b := newcomer(t)
	as := f.Issue(testSub, "me@example.com", b.SignPub, b.NoisePub, time.Now())
	out, _, err := AccountJoin(ctx, []string{rs.URL}, b, "b", as, offeredBy(t, a))
	if err != nil {
		t.Fatal(err)
	}
	cl := login.New(f.URL)
	for _, x := range []*ident.Identity{a.id, b} {
		if err := cl.Register(ctx, x, f.Issue(testSub, "me@example.com", x.SignPub, x.NoisePub, time.Now()), out.MeshID); err != nil {
			t.Fatal(err)
		}
	}
	f.ForgetStatus.Store(503)
	var r map[string]any
	if err := Call(a.st, Request{Op: "revoke", Subject: ident.B64.EncodeToString(b.SignPub)}, &r); err != nil {
		t.Fatal(err)
	}
	if code := <-f.ForgetAttempts(); code != 503 {
		t.Fatalf("attempt answered %d", code)
	}
	var saved []PendingForget
	if ok, err := a.st.ReadJSON(ForgetsFile, &saved); err != nil || !ok || len(saved) != 1 || saved[0].NodeID != b.NodeID() {
		t.Fatalf("pending forgets %+v (%v %v), want b kept for a retry", saved, ok, err)
	}
	a.d.Stop()
	if err := <-a.done; err != nil {
		t.Fatal(err)
	}
	a.done <- nil
	f.ForgetStatus.Store(0)
	a2 := start(t, ctx, rs, a.st, nil)
	if got := <-f.Forgotten(); got != b.NodeID() {
		t.Fatalf("forgot %s, want b", got)
	}
	_ = a2
}

func TestAJoinerRevokedElsewhereLearnsItWhenItSyncsAfterJoining(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := loginFake(t)
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	bindTo(t, a, f, f.Key())
	j := newcomer(t)
	as := f.Issue(testSub, "me@example.com", j.SignPub, j.NoisePub, time.Now())
	out, _, err := AccountJoin(ctx, []string{rs.URL}, j, "j", as, offeredBy(t, a))
	if err != nil {
		t.Fatal(err)
	}
	s, err := mesh.CheckJoined(nil, j, out.MeshID, out.Records)
	if err != nil {
		t.Fatal(err)
	}
	// b heard of j's admit from a and revokes it; the joiner holds only a's set.
	var r map[string]any
	if err := Call(b.st, Request{Op: "revoke", Subject: ident.B64.EncodeToString(j.SignPub)}, &r); err != nil {
		t.Fatal(err)
	}
	if _, _, err := FinishJoin(ctx, []string{rs.URL}, j, s, nil, nil); err == nil {
		t.Fatal("the joiner went on although a member it synced with had revoked it")
	}
}

func TestWithFourAssertedAccountSessionsAFifthIsRefused4429(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := loginFake(t)
	a := founder(t, ctx, rs, "a", nil)
	bindTo(t, a, f, f.Key())
	// Each of the four sends a valid assertion and holds the member waiting for its card.
	for range MaxAccountSessions {
		j := newcomer(t)
		toOffer(t, ctx, rs, a, j, f.Issue(testSub, "me@example.com", j.SignPub, j.NoisePub, time.Now()))
	}
	j := newcomer(t)
	_, err := OpenAny(ctx, []string{rs.URL}, a.id.NodeID(), func(conn relay.Conn) (*session.Secure, error) {
		return session.Initiate(ctx, conn, session.KindAccount, a.id.NodeID(), a.id.NoisePub, j, nil, session.Payload{V: 1, Stream: "account", Name: "j"})
	})
	if relay.CodeOf(err) != wire.CodeCaps {
		t.Fatalf("fifth session: %v, want 4429", err)
	}
}

func TestAnOfflineMemberThatAnnounced11EarlierDoesNotBlockLockButOneThatNeverDid(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	var r map[string]any
	for _, on := range []bool{true, false} {
		if err := Call(a.st, Request{Op: "lock", On: on}, &r); err != nil {
			t.Fatalf("lock %v with b online: %v", on, err)
		}
	}
	// b goes offline and a restarts: only a's stored record of b's announcement remains.
	stop := func(n *node) {
		n.d.Stop()
		if err := <-n.done; err != nil {
			t.Fatal(err)
		}
		n.done <- nil
	}
	stop(b)
	stop(a)
	a2 := start(t, ctx, rs, a.st, nil)
	if err := Call(a2.st, Request{Op: "lock", On: true}, &r); err != nil {
		t.Fatalf("lock with b offline after it announced 1.1: %v", err)
	}
	// c joins but never runs, so it never announces a version.
	st := shortDir(t)
	tok := a2.invite(t, time.Minute)
	id := identity(t, st, tok.Relays[0], "c")
	s, err := Join(ctx, st, id, tok, "c")
	if err != nil {
		t.Fatal(err)
	}
	s.Save()
	err = Call(a2.st, Request{Op: "lock", On: false}, &r)
	if err == nil || !strings.HasSuffix(err.Error(), ": c") {
		t.Fatalf("unlock with c never heard from: %v, want a refusal naming c only", err)
	}
}

func TestAForgetRefusedForClockSkewOrRateIsRetriedAndABadRequestIsDropped(t *testing.T) {
	cases := []struct {
		status int
		kept   bool
	}{{401, true}, {429, true}, {403, true}, {400, false}, {404, false}, {409, false}}
	for _, c := range cases {
		ctx, cancel := context.WithCancel(context.Background())
		rs := relaytest.New()
		f := loginFake(t)
		st := shortDir(t)
		id := identity(t, st, rs.URL, "a")
		if _, err := mesh.Found(st, id, "a", 1); err != nil {
			t.Fatal(err)
		}
		type attempt struct {
			nodeID string
			kept   bool
		}
		seen := make(chan attempt, 8)
		a := startWith(t, ctx, rs, st, func(o *Options) {
			o.OnForget = func(nodeID string, _ error, kept bool) { seen <- attempt{nodeID, kept} }
		})
		bindTo(t, a, f, f.Key())
		b := newcomer(t)
		as := f.Issue(testSub, "me@example.com", b.SignPub, b.NoisePub, time.Now())
		if _, _, err := AccountJoin(ctx, []string{rs.URL}, b, "b", as, offeredBy(t, a)); err != nil {
			t.Fatal(err)
		}
		f.ForgetStatus.Store(int32(c.status))
		var r map[string]any
		if err := Call(a.st, Request{Op: "revoke", Subject: ident.B64.EncodeToString(b.SignPub)}, &r); err != nil {
			t.Fatal(err)
		}
		got := <-seen
		if got.nodeID != b.NodeID() || got.kept != c.kept {
			t.Fatalf("answer %d: forget of %s kept %v, want kept %v", c.status, got.nodeID, got.kept, c.kept)
		}
		cancel()
		rs.Close()
	}
}

func TestAForgetRefusedForClockSkewIsRetried(t *testing.T) {
	// pen-login answers a forget whose ts is outside its window with 400 {"error":"stale"}.
	if answered(&login.HTTPError{Status: 400, Body: `{"error":"stale"}`}) {
		t.Fatal("a stale forget was treated as final")
	}
	if !answered(&login.HTTPError{Status: 400, Body: `{"error":"bad_proof"}`}) {
		t.Fatal("a malformed forget was retried")
	}
}

func TestACorruptVersionsFileIsReadAsEmpty(t *testing.T) {
	st := shortDir(t)
	if err := os.WriteFile(st.Path(VersionsFile), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Reading it as empty still fails closed: no member counts as 1.1 until it announces again.
	v, err := loadVersions(st)
	if err != nil || len(v) != 0 {
		t.Fatalf("versions %v, %v; want an empty map and no error", v, err)
	}
}

func TestAVersionsFileHoldingNullDoesNotCrashTheFirstHello(t *testing.T) {
	st := shortDir(t)
	if err := os.WriteFile(st.Path(VersionsFile), []byte("null"), 0o600); err != nil {
		t.Fatal(err)
	}
	v, err := loadVersions(st)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	d := &Daemon{st: st, versions: v}
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("a versions.json holding null made the first sync hello panic: %v", r)
		}
	}()
	d.helloFrom([]byte("0123456789abcdef0123456789abcdef"))(mesh.Version)
}

func TestACompromisedRevokeThatDropsTheBindingStillForgetsTheKey(t *testing.T) {
	st := shortDir(t)
	d := &Daemon{st: st, nodeID: "self", forgets: &forgetBook{st: st, kick: make(chan struct{}, 1)}}
	bound := &mesh.Account{LoginURL: "https://login.example", Sub: testSub}
	old := &mesh.View{Account: bound, Revoked: map[string]mesh.Member{}}
	// The stolen laptop signed the binding, so revoking it as compromised drops the binding too.
	v := &mesh.View{Revoked: map[string]mesh.Member{"laptopSignPub": {NodeID: "laptop"}}}
	d.forgetRevoked(old, v)
	got := d.forgets.pending()
	if len(got) != 1 || got[0].NodeID != "laptop" || got[0].LoginURL != bound.LoginURL {
		t.Fatalf("forgets %+v; want the compromised laptop forgotten at %s", got, bound.LoginURL)
	}
}

// Q4: a request queued under one login service is not approved after the mesh is rebound to
// another with the same key and account, and an entry queued by an older pen (no issuer or key) is
// refused with what to do; nothing is signed in either case.
func TestApproveComparesIssuerAccountAndKeyWithTheBindingAtSigning(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := loginFake(t)
	a := founder(t, ctx, rs, "a", nil)
	bindTo(t, a, f, f.Key())
	var lr map[string]any
	if err := Call(a.st, Request{Op: "lock", On: true}, &lr); err != nil {
		t.Fatal(err)
	}
	queue := func() string {
		b := newcomer(t)
		as := f.Issue(testSub, "me@example.com", b.SignPub, b.NoisePub, time.Now())
		out, _, err := AccountJoin(ctx, []string{rs.URL}, b, "b", as, offeredBy(t, a))
		if err != nil || out.QueuedID == "" {
			t.Fatalf("queue: %+v %v", out, err)
		}
		return ident.Fingerprint(b.NoisePub)
	}
	old := queue()
	a.d.pending.mu.Lock()
	for i := range a.d.pending.list {
		a.d.pending.list[i].Issuer, a.d.pending.list[i].Kid = "", ""
	}
	a.d.pending.mu.Unlock()
	var ar ApproveResult
	if err := Call(a.st, Request{Op: "approve", Subject: old}, &ar); err == nil || !strings.Contains(err.Error(), "pen login again") {
		t.Fatalf("approving an entry without issuer and key: %v", err)
	}
	fresh := queue()
	rebound := &mesh.Account{LoginURL: "https://other-login.example", LoginKey: mesh.LoginKey(f.Key()), Sub: testSub}
	var signedBefore int
	beforeAccountAdmit = func() {
		if _, err := a.d.mesh().Append(a.d.id, mesh.TypeAccount, a.d.now().UnixMilli(), mesh.Fields{Bind: rebound}); err != nil {
			t.Fatal(err)
		}
		signedBefore = len(a.d.mesh().Records())
	}
	defer func() { beforeAccountAdmit = nil }()
	_, err := a.d.approve(ctx, fresh)
	if err == nil || !strings.Contains(err.Error(), "no longer bound") {
		t.Errorf("approval after binding changed at signing: %v", err)
	}
	if got := len(a.d.mesh().Records()); got != signedBefore {
		t.Errorf("approval signed %d records after the binding changed", got-signedBefore)
	}
	if n := len(a.ls(t).Members); n != 1 {
		t.Fatalf("%d members: something was admitted", n)
	}
}
