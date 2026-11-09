package daemon

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/session"
	"github.com/goat-si/goat/apps/pen/internal/state"
	"github.com/goat-si/goat/apps/pen/internal/stream"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// clock is a settable test clock.
type clock struct{ ms atomic.Int64 }

func (c *clock) now() time.Time          { return time.UnixMilli(c.ms.Load()) }
func (c *clock) advance(d time.Duration) { c.ms.Add(d.Milliseconds()) }

type node struct {
	st   *state.Store
	id   *ident.Identity
	d    *Daemon
	done chan error
}

// shortDir keeps unix socket paths under the 104-byte macOS limit.
func shortDir(t *testing.T) *state.Store {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "pen")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	st, err := state.OpenDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func identity(t *testing.T, st *state.Store, relayURL, name string) *ident.Identity {
	t.Helper()
	id, _, err := st.EnsureIdentity()
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SaveConfig(state.Config{Relay: relayURL, Name: name}); err != nil {
		t.Fatal(err)
	}
	return id
}

func start(t *testing.T, ctx context.Context, rs *relaytest.Server, st *state.Store, clk *clock) *node {
	t.Helper()
	ready := make(chan struct{})
	opt := Options{Store: st, HostKeyGlob: "none", KnownHosts: "none", Ready: func() { close(ready) }, Logf: t.Logf}
	if clk != nil {
		opt.Now = clk.now
	}
	d, err := New(opt)
	if err != nil {
		t.Fatal(err)
	}
	n := &node{st: st, id: d.id, d: d, done: make(chan error, 1)}
	go func() { n.done <- d.Run(ctx) }()
	<-ready
	if err := rs.WaitOnline(ctx, d.NodeID()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Stop(); <-n.done })
	return n
}

// founder makes a node with a new mesh and runs it.
func founder(t *testing.T, ctx context.Context, rs *relaytest.Server, name string, clk *clock) *node {
	st := shortDir(t)
	id := identity(t, st, rs.URL, name)
	if _, err := mesh.Found(st, id, name, 1); err != nil {
		t.Fatal(err)
	}
	return start(t, ctx, rs, st, clk)
}

func (n *node) invite(t *testing.T, ttl time.Duration) mesh.Token {
	t.Helper()
	var r struct{ Token string }
	if err := Call(n.st, Request{Op: "invite", TTLMs: ttl.Milliseconds()}, &r); err != nil {
		t.Fatal(err)
	}
	tok, err := mesh.ParseToken(r.Token)
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func (n *node) ls(t *testing.T) LsReply {
	t.Helper()
	var r LsReply
	if err := Call(n.st, Request{Op: "ls"}, &r); err != nil {
		t.Fatal(err)
	}
	return r
}

// joiner joins tok from a fresh state directory and starts its daemon.
func joiner(t *testing.T, ctx context.Context, rs *relaytest.Server, tok mesh.Token, name string) *node {
	t.Helper()
	st := shortDir(t)
	id := identity(t, st, tok.Relays[0], name)
	s, err := Join(ctx, st, id, tok, name)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Save(); err != nil {
		t.Fatal(err)
	}
	return start(t, ctx, rs, st, nil)
}

func names(ms []LsMember) string {
	var out []string
	for _, m := range ms {
		out = append(out, m.Name)
	}
	return strings.Join(out, ",")
}

// watch streams a node's view lines.
func (n *node) watch(t *testing.T) (<-chan WatchLine, func()) {
	t.Helper()
	cl, err := Dial(n.st)
	if err != nil {
		t.Fatal(err)
	}
	if err := cl.Send(Request{Op: "watch"}); err != nil {
		t.Fatal(err)
	}
	ch := make(chan WatchLine, 64)
	go func() {
		defer close(ch)
		for {
			var w WatchLine
			if cl.Next(&w) != nil {
				return
			}
			ch <- w
		}
	}()
	return ch, func() { cl.Close() }
}

func untilView(t *testing.T, ch <-chan WatchLine, ok func(WatchLine) bool) WatchLine {
	t.Helper()
	for w := range ch {
		if ok(w) {
			return w
		}
	}
	t.Fatal("watch ended")
	return WatchLine{}
}

func hasRef(refs []NameRef, nodeID string) bool {
	for _, r := range refs {
		if r.NodeID == nodeID {
			return true
		}
	}
	return false
}

func TestJoinEndToEndInviterAutoAdmitsAndJoinerIsAMemberInBothViews(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, 10*time.Minute), "b")
	if got := names(a.ls(t).Members); got != "a,b" {
		t.Fatalf("inviter view %q", got)
	}
	lb := b.ls(t)
	if got := names(lb.Members); got != "a,b" || lb.MeshID != a.ls(t).MeshID {
		t.Fatalf("joiner view %q", got)
	}
	for _, m := range lb.Members {
		if m.Name == "b" && m.AdmittedByName != "a" {
			t.Fatalf("b admitted by %q", m.AdmittedByName)
		}
	}
}

func TestTwoJoinsRacingOnOneInviteGiveExactlyOneMemberAndOne4401(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	tok := a.invite(t, 10*time.Minute)
	release := make(chan struct{})
	errs := make([]error, 2)
	var wg sync.WaitGroup
	for i := range 2 {
		st := shortDir(t)
		id := identity(t, st, rs.URL, "c")
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-release
			_, errs[i] = Join(ctx, st, id, tok, []string{"c1", "c2"}[i])
		}()
	}
	close(release)
	wg.Wait()
	ok, refused := 0, 0
	for _, err := range errs {
		switch {
		case err == nil:
			ok++
		case strings.Contains(err.Error(), "4401"):
			refused++
		default:
			t.Fatalf("unexpected join error: %v", err)
		}
	}
	if ok != 1 || refused != 1 {
		t.Fatalf("%d joined, %d refused: %v", ok, refused, errs)
	}
	if n := len(a.ls(t).Members); n != 2 {
		t.Fatalf("inviter has %d members", n)
	}
}

func TestExpiredInviteCloses4401(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	clk := &clock{}
	clk.ms.Store(time.Now().UnixMilli())
	a := founder(t, ctx, rs, "a", clk)
	tok := a.invite(t, 10*time.Minute)
	clk.advance(10*time.Minute + time.Millisecond)
	st := shortDir(t)
	_, err := Join(ctx, st, identity(t, st, rs.URL, "b"), tok, "b")
	if err == nil || !strings.Contains(err.Error(), "4401") {
		t.Fatalf("got %v, want 4401", err)
	}
}

func TestUnknownInviteIDCloses4401Unanswered(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	tok := a.invite(t, 10*time.Minute)
	conn, err := relay.Dial(ctx, rs.URL, a.d.NodeID())
	if err != nil {
		t.Fatal(err)
	}
	secret := make([]byte, 32)
	rand.Read(secret)
	psk, _ := session.JoinPSK(secret, a.d.NodeID(), tok.NoisePub)
	stranger, _ := ident.Generate(nil)
	// Initiate sends message 1 and reads; an answered refusal would be message 2, not a close.
	_, err = session.Initiate(ctx, conn, session.KindJoin, a.d.NodeID(), tok.NoisePub, stranger, psk,
		session.Payload{V: 1, Stream: "join", Invite: session.InviteID(secret), Name: "x"})
	if relay.CodeOf(err) != wire.CodeNotAdmitted {
		t.Fatalf("got %v, want 4401 before message 2", err)
	}
}

func TestNonMemberSessionIsClosed4401(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	stranger, _ := ident.Generate(nil)
	self := a.ls(t).Members[0].Member
	_, err := OpenTCP(ctx, []string{rs.URL}, stranger, self, 22)
	if relay.CodeOf(err) != wire.CodeNotAdmitted {
		t.Fatalf("got %v, want 4401", err)
	}
}

func echoServer(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				io.Copy(c, c)
				c.(*net.TCPConn).CloseWrite()
				c.Close()
			}()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

func memberNamed(t *testing.T, n *node, name string) mesh.Member {
	t.Helper()
	for _, m := range n.ls(t).Members {
		if m.Name == name {
			return m.Member
		}
	}
	t.Fatalf("no member %q", name)
	return mesh.Member{}
}

func TestTCPStreamCarriesBytesToALocalPortAndRefusedPortCloses4404(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	port := echoServer(t)
	sec, err := OpenTCP(ctx, []string{rs.URL}, b.id, memberNamed(t, b, "a"), port)
	if err != nil {
		t.Fatal(err)
	}
	src := make([]byte, 3<<20)
	rand.Read(src)
	var got bytes.Buffer
	if err := stream.Splice(ctx, sec, bytes.NewReader(src), &got, nil); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got.Bytes(), src) {
		t.Fatal("echoed bytes differ")
	}

	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	closed := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	sec, err = OpenTCP(ctx, []string{rs.URL}, b.id, memberNamed(t, b, "a"), closed)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sec.Recv(ctx); relay.CodeOf(err) != wire.CodeOffline {
		t.Fatalf("got %v, want 4404 port refused", err)
	}
}

// gate holds a link's second send (the key confirmation) until release is closed.
type gate struct {
	relay.Conn
	n       int
	reached chan struct{}
	release chan struct{}
}

func (g *gate) Send(p []byte) error {
	if g.n++; g.n == 2 {
		close(g.reached)
		<-g.release
	}
	return g.Conn.Send(p)
}

func TestMemberRevokedBeforeItConfirmsGets4401AndNoDial(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	var dialed atomic.Int64
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			dialed.Add(1)
			go func() { io.Copy(c, c); c.Close() }()
		}
	}()
	am := memberNamed(t, b, "a")
	noise, _ := ident.DecodeKey(am.NoisePub)
	conn, err := relay.Dial(ctx, rs.URL, am.NodeID)
	if err != nil {
		t.Fatal(err)
	}
	g := &gate{Conn: conn, reached: make(chan struct{}), release: make(chan struct{})}
	type res struct {
		sec *session.Secure
		err error
	}
	done := make(chan res, 1)
	go func() {
		sec, err := session.Initiate(ctx, g, session.KindSession, am.NodeID, noise, b.id, nil,
			session.Payload{V: 1, Stream: "tcp", Port: ln.Addr().(*net.TCPAddr).Port})
		done <- res{sec, err}
	}()
	<-g.reached // a admitted b at message 1 and answered; b has not confirmed yet
	var out struct{ Results []PushResult }
	if err := Call(a.st, Request{Op: "revoke", Subject: memberNamed(t, a, "b").SignPub}, &out); err != nil {
		t.Fatal(err)
	}
	close(g.release)
	r := <-done
	if r.err != nil {
		t.Fatal(r.err)
	}
	r.sec.Send(append([]byte{stream.TypeData}, "x"...))
	r.sec.Send([]byte{stream.TypeFin})
	if p, err := r.sec.Recv(ctx); relay.CodeOf(err) != wire.CodeNotAdmitted {
		t.Fatalf("revoked member's session got %x, %v; want 4401", p, err)
	}
	if n := dialed.Load(); n != 0 {
		t.Fatalf("a dialed the port %d time(s) for a revoked member", n)
	}
}

func TestRevokeCarriedElsewhereClosesTheSubjectsOpenMeshSessionAtOnce(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	c := joiner(t, ctx, rs, a.invite(t, time.Minute), "c")
	// c holds a mesh session open at a: a has sent its hello, c has sent nothing yet.
	am := memberNamed(t, c, "a")
	noise, _ := ident.DecodeKey(am.NoisePub)
	conn, err := relay.Dial(ctx, rs.URL, am.NodeID)
	if err != nil {
		t.Fatal(err)
	}
	sec, err := session.Initiate(ctx, conn, session.KindSession, am.NodeID, noise, c.id, nil, session.Payload{V: 1, Stream: "mesh"})
	if err != nil {
		t.Fatal(err)
	}
	lines := &mesh.Lines{L: sec}
	if m, err := lines.Read(ctx); err != nil || m.T != "hello" {
		t.Fatalf("first line %+v, %v", m, err)
	}
	// b revokes c and pushes to a over a different session; a stores it before answering b's done.
	var out struct{ Results []PushResult }
	if err := Call(b.st, Request{Op: "revoke", Subject: memberNamed(t, b, "c").SignPub}, &out); err != nil {
		t.Fatal(err)
	}
	lines.Write(mesh.Msg{T: "hello", Have: nil})
	lines.Write(mesh.Msg{T: "done"})
	for {
		m, err := lines.Read(ctx)
		if err != nil {
			if relay.CodeOf(err) != wire.CodeNotAdmitted {
				t.Fatalf("got %v, want 4401", err)
			}
			return
		}
		if m.T == "done" {
			t.Fatal("a finished a sync with a key revoked on another session instead of closing it at once")
		}
	}
}

func TestHandshakeFailureAfterWinningThePingRaceFallsBackToTheNextRelay(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// Relay b holds the node's live uplink; clients reach it only once gate opens.
	rb := relaytest.NewUnstarted()
	gate := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/client/") {
			<-gate
		}
		rb.Relay.ServeHTTP(w, r)
	}))
	defer srv.Close()
	rb.URL = srv.URL
	a := founder(t, ctx, rb, "a", nil)
	// Relay s holds a stale uplink for the same node: it answers pong but drops every session.
	rs := relaytest.New()
	defer rs.Close()
	stale := relay.NewUplink(rs.URL, a.id)
	go stale.Run(ctx)
	if err := rs.WaitOnline(ctx, a.d.NodeID()); err != nil {
		t.Fatal(err)
	}
	go func() {
		c, err := stale.Accept(ctx)
		if err != nil {
			return
		}
		c.Close(wire.CodeOffline)
		close(gate)
	}()
	tok := a.invite(t, time.Minute)
	psk, _ := session.JoinPSK(tok.Secret, a.d.NodeID(), tok.NoisePub)
	joiner, _ := ident.Generate(nil)
	payload := session.Payload{V: 1, Stream: "join", Invite: session.InviteID(tok.Secret), Name: "b"}
	sec, err := OpenAny(ctx, []string{rs.URL, rb.URL}, a.d.NodeID(), func(c relay.Conn) (*session.Secure, error) {
		return session.Initiate(ctx, c, session.KindJoin, a.d.NodeID(), tok.NoisePub, joiner, psk, payload)
	})
	if err != nil {
		t.Fatalf("handshake through the second relay: %v", err)
	}
	sec.Close(wire.CodeNormal)
}

func TestOnlyABatchHoldingThePeersRevokeDefersItsSessionClose(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	c := joiner(t, ctx, rs, a.invite(t, time.Minute), "c")
	cm := memberNamed(t, a, "c")
	var out struct{ Results []PushResult }
	if err := Call(a.st, Request{Op: "revoke", Subject: cm.SignPub}, &out); err != nil {
		t.Fatal(err)
	}
	var revoke *mesh.Record
	for _, r := range a.d.mesh().Records() {
		if r.B.Type == mesh.TypeRevoke {
			revoke = r
		}
	}
	unrelated, err := a.d.mesh().Append(a.id, mesh.TypeName, 9, mesh.Fields{Subject: ident.B64.EncodeToString(a.id.SignPub), Name: "a2"})
	if err != nil {
		t.Fatal(err)
	}
	if a.d.carriesPeerRevoke(c.id.NoisePub, []*mesh.Record{unrelated}) {
		t.Fatal("a batch without the peer's revoke deferred the close of a session already revoked elsewhere")
	}
	if !a.d.carriesPeerRevoke(c.id.NoisePub, []*mesh.Record{revoke}) {
		t.Fatal("the batch that holds the peer's revoke did not defer the close")
	}
}

func TestRevokeClosesTheRevokedMembersLiveSessions4401(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	sec, err := OpenTCP(ctx, []string{rs.URL}, b.id, memberNamed(t, b, "a"), echoServer(t))
	if err != nil {
		t.Fatal(err)
	}
	var res struct{ Results []PushResult }
	if err := Call(a.st, Request{Op: "revoke", Subject: memberNamed(t, a, "b").SignPub}, &res); err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := sec.Recv(ctx); err != nil {
			if relay.CodeOf(err) != wire.CodeNotAdmitted {
				t.Fatalf("got %v, want 4401", err)
			}
			break
		}
	}
	if len(res.Results) != 0 {
		t.Fatalf("push went to %v; b is no longer a member and a has no others", res.Results)
	}
}

func TestInvitesMadeAfterARunningNodeJoinsArePersisted(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := founder(t, ctx, rs, "b", nil)
	var ls LsReply
	if err := Call(b.st, Request{Op: "join", Token: a.invite(t, time.Minute).String(), Name: "b"}, &ls); err != nil {
		t.Fatal(err)
	}
	if len(ls.Members) != 2 || ls.MeshID != a.ls(t).MeshID {
		t.Fatalf("b after join: %+v", ls)
	}
	tok := b.invite(t, time.Minute)
	var saved []mesh.Invite
	if ok, err := b.st.ReadJSON("offers.json", &saved); err != nil || !ok || len(saved) != 1 || saved[0].ID != session.InviteID(tok.Secret) {
		t.Fatalf("offers.json after join: present=%v %v, %d invites", ok, err, len(saved))
	}
}

func TestLeavePushReportsTakenAndDeletesKeys(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	bID := b.d.NodeID()
	var res struct{ Results []PushResult }
	if err := Call(b.st, Request{Op: "leave"}, &res); err != nil {
		t.Fatal(err)
	}
	if len(res.Results) != 1 || res.Results[0].Name != "a" || res.Results[0].Result != "taken" {
		t.Fatalf("leave results %+v", res.Results)
	}
	la := a.ls(t)
	if len(la.Members) != 1 || len(la.Revoked) != 1 || la.Revoked[0].NodeID != bID {
		t.Fatalf("inviter view after leave: %+v", la)
	}
	if err := <-b.done; err != nil {
		t.Fatal(err)
	}
	b.done <- nil
	if _, err := b.st.LoadIdentity(); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("identity still present: %v", err)
	}
	if _, err := os.Stat(b.st.Path(LeftMarker)); err != nil {
		t.Fatalf("no left marker after leave: %v", err)
	}
}

func TestThreeNodesRevokeOnAReachesAWatchOnB(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	aw, stopA := a.watch(t)
	defer stopA()
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	c := joiner(t, ctx, rs, b.invite(t, time.Minute), "c")
	cID := c.d.NodeID()
	untilView(t, aw, func(w WatchLine) bool { return len(w.Members) == 3 })
	for _, n := range []*node{a, b, c} {
		if got := names(n.ls(t).Members); got != "a,b,c" {
			t.Fatalf("%s lists %q", n.d.NodeID(), got)
		}
	}
	bw, stopB := b.watch(t)
	defer stopB()
	untilView(t, bw, func(w WatchLine) bool { return len(w.Members) == 3 })
	began := time.Now()
	var res struct{ Results []PushResult }
	if err := Call(a.st, Request{Op: "revoke", Subject: memberNamed(t, a, "c").SignPub}, &res); err != nil {
		t.Fatal(err)
	}
	w := untilView(t, bw, func(w WatchLine) bool { return hasRef(w.Revoked, cID) })
	t.Logf("revoke on a reached b's watch in %v (results %+v)", time.Since(began), res.Results)
	if hasRef(w.Members, cID) || len(w.Members) != 2 {
		t.Fatalf("b's view after revoke: %+v", w)
	}
}

func TestUplinkReturnSyncsRecordsSignedWhileOffline(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	bID := b.d.NodeID()
	b.d.Stop()
	<-b.done
	b.done <- nil
	var st Status
	if err := Call(a.st, Request{Op: "name", Name: "alpha"}, &st); err != nil {
		t.Fatal(err)
	}
	if st.Name != "alpha" {
		t.Fatalf("name %q", st.Name)
	}
	b2 := start(t, ctx, rs, b.st, nil)
	w, stop := b2.watch(t)
	defer stop()
	untilView(t, w, func(w WatchLine) bool {
		for _, m := range w.Members {
			if m.NodeID == a.d.NodeID() && m.Name == "alpha" {
				return true
			}
		}
		return false
	})
	_ = bID
}

func TestLeaveThatNoMemberTookKeepsTheKeysAndTheNodeRunning(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	actx, stopA := context.WithCancel(ctx)
	a := founder(t, actx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	stopA()
	a.done <- <-a.done // Cleanup reads it again
	var res struct{ Results []PushResult }
	err := Call(b.st, Request{Op: "leave"}, &res)
	if err == nil {
		t.Fatalf("leave with every member unreachable reported success: %+v", res.Results)
	}
	if _, err := b.st.LoadIdentity(); err != nil {
		t.Fatalf("keys deleted although no member learned of the leave: %v", err)
	}
	if _, err := os.Stat(b.st.Path(LeftMarker)); !os.IsNotExist(err) {
		t.Fatalf("left marker written although the leave did not reach the mesh: %v", err)
	}
}
