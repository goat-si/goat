package daemon

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
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
	if err := cl.Register(ctx, as, out.MeshID); err != nil {
		t.Fatal(err)
	}
	// The founder registered when it bound the mesh; only a node under the account may forget another.
	if err := cl.Register(ctx, f.Issue(testSub, "me@example.com", a.id.SignPub, a.id.NoisePub, time.Now()), out.MeshID); err != nil {
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
	if err := login.New(f.URL).Register(ctx, as, out.MeshID); err != nil {
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
