package relayserver_test

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relayserver"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

const ackStep = 64 << 10

func startRelay(t *testing.T, l relayserver.Limits) *relaytest.Server {
	rs := relaytest.NewWithLimits(l)
	rs.Start()
	t.Cleanup(rs.Close)
	return rs
}

func defaults(t *testing.T) *relaytest.Server { return startRelay(t, relayserver.DefaultLimits()) }

func short(auth, pending, idle time.Duration) relayserver.Limits {
	l := relayserver.DefaultLimits()
	if auth > 0 {
		l.AuthTimeout = auth
	}
	if pending > 0 {
		l.PendingTimeout = pending
	}
	if idle > 0 {
		l.IdleTimeout = idle
	}
	return l
}

// peer is a raw relay socket: it counts what arrives, acks every 64 KiB when asked, and hands
// binary messages, texts and the close code to channels.
type peer struct {
	ws       *websocket.Conn
	msgs     chan []byte
	texts    chan string
	closed   chan int
	received atomic.Uint64
}

func dial(t *testing.T, url string, ack bool, already int) *peer { return dialHost(t, url, "") }

func dialHost(t *testing.T, url, host string) *peer {
	t.Helper()
	ws, _, err := websocket.Dial(context.Background(), url, &websocket.DialOptions{CompressionMode: websocket.CompressionDisabled, Host: host})
	if err != nil {
		t.Fatal(err)
	}
	ws.SetReadLimit(4 << 20)
	p := &peer{ws: ws, msgs: make(chan []byte, 8192), texts: make(chan string, 64), closed: make(chan int, 1)}
	t.Cleanup(func() { ws.CloseNow() })
	return p
}

func (p *peer) run(ack bool) {
	var acked uint64
	for {
		typ, b, err := p.ws.Read(context.Background())
		if err != nil {
			p.closed <- int(websocket.CloseStatus(err))
			return
		}
		if typ == websocket.MessageText {
			p.texts <- string(b)
			continue
		}
		n := p.received.Add(uint64(len(b)))
		if ack && n-acked >= ackStep {
			acked = n
			p.ws.Write(context.Background(), websocket.MessageText, []byte(wire.FormatAck(n)))
		}
		p.msgs <- b
	}
}

func (p *peer) send(b []byte)     { p.ws.Write(context.Background(), websocket.MessageBinary, b) }
func (p *peer) sendText(s string) { p.ws.Write(context.Background(), websocket.MessageText, []byte(s)) }

type nodeOpts struct {
	silent bool
	noAck  bool
	path   string
	origin string
	host   string
	answer func(signPub, sig []byte) []byte
}

type fakeNode struct {
	*peer
	id     *ident.Identity
	nodeID string
}

func node(t *testing.T, rs *relaytest.Server, o nodeOpts) *fakeNode {
	t.Helper()
	id, _ := ident.Generate(nil)
	return nodeWith(t, rs, id, o)
}

func nodeWith(t *testing.T, rs *relaytest.Server, id *ident.Identity, o nodeOpts) *fakeNode {
	t.Helper()
	path := id.NodeID()
	if o.path != "" {
		path = o.path
	}
	u, _ := wire.WebSocketURL(rs.URL, "/v1/node/"+path)
	p := dialHost(t, u, o.host)
	_, challenge, err := p.ws.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	p.received.Store(uint64(len(challenge)))
	n := &fakeNode{peer: p, id: id, nodeID: id.NodeID()}
	if !o.silent {
		origin, _ := wire.RelayOrigin(rs.URL)
		if o.origin != "" {
			origin = o.origin
		}
		sig := ed25519.Sign(id.SignPriv, wire.ChallengeMessage(origin, path, challenge))
		ans := append(append([]byte(nil), id.SignPub...), sig...)
		if o.answer != nil {
			ans = o.answer(id.SignPub, sig)
		}
		p.send(ans)
	}
	go p.run(!o.noAck)
	return n
}

// ready returns a node whose uplink the relay has made current.
func ready(t *testing.T, rs *relaytest.Server, o nodeOpts) *fakeNode {
	t.Helper()
	n := node(t, rs, o)
	if err := rs.WaitOnline(context.Background(), n.nodeID); err != nil {
		t.Fatal(err)
	}
	return n
}

func (n *fakeNode) frame(t *testing.T) wire.Frame {
	t.Helper()
	select {
	case b := <-n.msgs:
		f, err := wire.DecodeFrame(b)
		if err != nil {
			t.Fatal(err)
		}
		return f
	case code := <-n.closed:
		t.Fatalf("uplink closed %d while a frame was expected", code)
	}
	return wire.Frame{}
}

func (n *fakeNode) expect(t *testing.T, typ byte, sid uint32) wire.Frame {
	t.Helper()
	f := n.frame(t)
	if f.Type != typ || sid != 0 && f.SID != sid {
		t.Fatalf("frame %d/%d, want %d/%d", f.Type, f.SID, typ, sid)
	}
	return f
}

// closeOf skips the session's DATA frames until its CLOSE.
func (n *fakeNode) closeOf(t *testing.T, sid uint32) uint16 {
	t.Helper()
	for {
		f := n.frame(t)
		if f.Type == wire.FrameClose && f.SID == sid {
			return f.CloseCode()
		}
		if f.Type != wire.FrameData || f.SID != sid {
			t.Fatalf("unexpected frame %d/%d", f.Type, f.SID)
		}
	}
}

func (n *fakeNode) frameOut(typ byte, sid uint32, payload []byte) {
	n.send(wire.Frame{Type: typ, SID: sid, Payload: payload}.Encode())
}

func client(t *testing.T, rs *relaytest.Server, nodeID string, ack bool) *peer {
	t.Helper()
	u, _ := wire.WebSocketURL(rs.URL, "/v1/client/"+nodeID)
	p := dial(t, u, ack, 0)
	go p.run(ack)
	return p
}

type session struct {
	c   *peer
	sid uint32
}

func open(t *testing.T, rs *relaytest.Server, n *fakeNode, ack bool) session {
	t.Helper()
	c := client(t, rs, n.nodeID, ack)
	return session{c, n.expect(t, wire.FrameOpen, 0).SID}
}

// active is a session the node has answered.
func active(t *testing.T, rs *relaytest.Server, n *fakeNode, ack bool) session {
	t.Helper()
	s := open(t, rs, n, ack)
	n.frameOut(wire.FrameData, s.sid, []byte("hi"))
	if got := string(<-s.c.msgs); got != "hi" {
		t.Fatalf("got %q", got)
	}
	return s
}

func closePayload(code uint16) []byte {
	b := make([]byte, 2)
	binary.LittleEndian.PutUint16(b, code)
	return b
}

func TestHealthzAnswersAndBadIDsAre400NonUpgrades426OtherPaths404(t *testing.T) {
	rs := defaults(t)
	res, err := http.Get(rs.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if string(body) != `{"ok":true,"version":"pen-relay/1.0"}` {
		t.Fatalf("healthz %s", body)
	}
	id, _ := ident.Generate(nil)
	n := id.NodeID()
	for path, want := range map[string]int{
		"/v1/node/" + strings.ToUpper(n): 400, "/v1/client/" + n + "1": 400,
		"/v1/node/" + n: 426, "/v1/client/" + n: 426, "/v2/node/" + n: 404,
	} {
		res, err := http.Get(rs.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != want {
			t.Fatalf("%s: %d, want %d", path, res.StatusCode, want)
		}
	}
}

func TestUplinkGetsOpenPerClientDataBothWaysAndCloseCodesCarry(t *testing.T) {
	rs := defaults(t)
	n := ready(t, rs, nodeOpts{})
	first := open(t, rs, n, true)
	second := open(t, rs, n, true)
	if second.sid <= first.sid {
		t.Fatalf("sids %d then %d", first.sid, second.sid)
	}
	first.c.send([]byte("hello"))
	if f := n.expect(t, wire.FrameData, first.sid); string(f.Payload) != "hello" {
		t.Fatalf("payload %q", f.Payload)
	}
	n.frameOut(wire.FrameData, second.sid, []byte("world"))
	if got := string(<-second.c.msgs); got != "world" {
		t.Fatalf("got %q", got)
	}
	first.c.ws.Close(4000, "")
	if code := n.expect(t, wire.FrameClose, first.sid).CloseCode(); code != 4000 {
		t.Fatalf("CLOSE %d, want 4000", code)
	}
	n.frameOut(wire.FrameClose, second.sid, []byte{0x01, 0x10})
	if code := <-second.c.closed; code != 4097 {
		t.Fatalf("client closed %d, want 4097", code)
	}
}

func TestWrongSignatureWrongPathAndShortAnswerClose4403(t *testing.T) {
	rs := defaults(t)
	other, _ := ident.Generate(nil)
	nodes := []*fakeNode{
		node(t, rs, nodeOpts{answer: func(pub, sig []byte) []byte {
			s := append([]byte(nil), sig...)
			s[0] ^= 1
			return append(append([]byte(nil), pub...), s...)
		}}),
		node(t, rs, nodeOpts{path: other.NodeID()}),
		node(t, rs, nodeOpts{answer: func(pub, sig []byte) []byte { return append(append([]byte(nil), pub...), sig...)[:95] }}),
	}
	for i, n := range nodes {
		if code := <-n.closed; code != int(wire.CodeRelayAuth) {
			t.Fatalf("case %d closed %d, want 4403", i, code)
		}
	}
}

func TestUnansweredChallengeCloses4403(t *testing.T) {
	rs := startRelay(t, short(300*time.Millisecond, 0, 0))
	n := node(t, rs, nodeOpts{silent: true})
	if code := <-n.closed; code != int(wire.CodeRelayAuth) {
		t.Fatalf("closed %d, want 4403", code)
	}
}

func TestClientForAnOfflineNodeCloses4404BeforeItsTextIsRead(t *testing.T) {
	rs := defaults(t)
	id, _ := ident.Generate(nil)
	c := client(t, rs, id.NodeID(), true)
	c.sendText("hello") // would be 1003 if the relay read it
	if code := <-c.closed; code != int(wire.CodeOffline) {
		t.Fatalf("closed %d, want 4404", code)
	}
}

func TestNewerUplinkReplacesWith4409ClosesSessions4404AndNeverReusesASid(t *testing.T) {
	rs := defaults(t)
	id, _ := ident.Generate(nil)
	old := nodeWith(t, rs, id, nodeOpts{})
	rs.WaitOnline(context.Background(), id.NodeID())
	s := active(t, rs, old, true)
	replacement := nodeWith(t, rs, id, nodeOpts{})
	if code := <-old.closed; code != int(wire.CodeReplaced) {
		t.Fatalf("old uplink closed %d, want 4409", code)
	}
	if code := <-s.c.closed; code != int(wire.CodeOffline) {
		t.Fatalf("its session closed %d, want 4404", code)
	}
	rs.WaitOnline(context.Background(), id.NodeID())
	next := open(t, rs, replacement, true)
	if next.sid <= s.sid {
		t.Fatalf("sid %d reused after %d", next.sid, s.sid)
	}
}

func TestNinthPendingSessionClosesTheOldestPending4429(t *testing.T) {
	rs := defaults(t)
	n := ready(t, rs, nodeOpts{})
	var pending []session
	for range relayserver.PendingMax {
		pending = append(pending, open(t, rs, n, true))
	}
	client(t, rs, n.nodeID, true)
	if code := n.expect(t, wire.FrameClose, pending[0].sid).CloseCode(); code != wire.CodeCaps {
		t.Fatalf("CLOSE %d, want 4429", code)
	}
	n.expect(t, wire.FrameOpen, 0)
	if code := <-pending[0].c.closed; code != int(wire.CodeCaps) {
		t.Fatalf("oldest pending closed %d, want 4429", code)
	}
}

func TestFirstNodeDataThatWouldMakeA33rdActiveSessionCloses4429(t *testing.T) {
	rs := defaults(t)
	n := ready(t, rs, nodeOpts{})
	for range relayserver.ActiveMax {
		active(t, rs, n, true)
	}
	extra := open(t, rs, n, true)
	n.frameOut(wire.FrameData, extra.sid, []byte("one too many"))
	if code := n.expect(t, wire.FrameClose, extra.sid).CloseCode(); code != wire.CodeCaps {
		t.Fatalf("CLOSE %d, want 4429", code)
	}
	if code := <-extra.c.closed; code != int(wire.CodeCaps) {
		t.Fatalf("closed %d, want 4429", code)
	}
}

func TestUnansweredSessionCloses4408AndTheNodeHearsIt(t *testing.T) {
	rs := startRelay(t, short(0, 300*time.Millisecond, 0))
	n := ready(t, rs, nodeOpts{})
	s := open(t, rs, n, true)
	if code := <-s.c.closed; code != int(wire.CodeTimeout) {
		t.Fatalf("closed %d, want 4408", code)
	}
	if code := n.expect(t, wire.FrameClose, s.sid).CloseCode(); code != wire.CodeTimeout {
		t.Fatalf("CLOSE %d, want 4408", code)
	}
}

func TestSocketThatSendsNoPingWithinTheIdleTimeoutCloses4408(t *testing.T) {
	rs := startRelay(t, short(0, 0, 300*time.Millisecond))
	n := node(t, rs, nodeOpts{})
	if code := <-n.closed; code != int(wire.CodeTimeout) {
		t.Fatalf("closed %d, want 4408", code)
	}
}

func TestHeavySessionPastItsFairShareEnds4408WhileALightOneKeepsFlowing(t *testing.T) {
	rs := defaults(t)
	n := ready(t, rs, nodeOpts{noAck: true})
	heavy := active(t, rs, n, true)
	light := active(t, rs, n, true)
	chunk := make([]byte, 64<<10)
	for range 70 {
		heavy.c.send(chunk)
	}
	if code := n.closeOf(t, heavy.sid); code != wire.CodeTimeout {
		t.Fatalf("heavy CLOSE %d, want 4408", code)
	}
	if code := <-heavy.c.closed; code != int(wire.CodeTimeout) {
		t.Fatalf("heavy closed %d", code)
	}
	if got := n.received.Load(); got > relayserver.SocketWindow-relayserver.LightSession+7 {
		t.Fatalf("uplink got %d bytes, past 4 MiB minus 16 KiB", got)
	}
	light.c.send([]byte("still here"))
	if f := n.expect(t, wire.FrameData, light.sid); string(f.Payload) != "still here" {
		t.Fatalf("light payload %q", f.Payload)
	}
}

func TestFrameTypesOtherThanDataAndCloseFromTheNodeClose4402AndItsSessions4404(t *testing.T) {
	rs := defaults(t)
	for _, typ := range []byte{wire.FrameOpen, 4, 5, 6, 7, 9} {
		n := ready(t, rs, nodeOpts{})
		s := open(t, rs, n, true)
		n.frameOut(typ, s.sid, nil)
		if code := <-n.closed; code != int(wire.CodeRelayProtocol) {
			t.Fatalf("type %d: uplink closed %d, want 4402", typ, code)
		}
		if code := <-s.c.closed; code != int(wire.CodeOffline) {
			t.Fatalf("type %d: session closed %d, want 4404", typ, code)
		}
	}
	junk := ready(t, rs, nodeOpts{})
	junk.send([]byte{2, 0, 0})
	if code := <-junk.closed; code != int(wire.CodeRelayProtocol) {
		t.Fatalf("short frame closed %d", code)
	}
}

func TestNonDecimalDecreasingOrOverSentAcksClose4402(t *testing.T) {
	rs := defaults(t)
	cases := map[string]func(n *fakeNode){
		"non-decimal":  func(n *fakeNode) { n.sendText("a:1x") },
		"leading zero": func(n *fakeNode) { n.sendText("a:01") },
		"over":         func(n *fakeNode) { n.sendText(wire.FormatAck(n.received.Load() + 1)) },
		"decreasing": func(n *fakeNode) {
			n.sendText(wire.FormatAck(n.received.Load()))
			n.sendText(wire.FormatAck(n.received.Load() - 1))
		},
	}
	for name, f := range cases {
		n := ready(t, rs, nodeOpts{noAck: true})
		f(n)
		if code := <-n.closed; code != int(wire.CodeRelayProtocol) {
			t.Fatalf("%s: closed %d, want 4402", name, code)
		}
	}
	n := ready(t, rs, nodeOpts{})
	s := open(t, rs, n, true)
	s.c.sendText("a:1")
	if code := <-s.c.closed; code != int(wire.CodeRelayProtocol) {
		t.Fatalf("client closed %d, want 4402", code)
	}
	if code := n.expect(t, wire.FrameClose, s.sid).CloseCode(); code != wire.CodeRelayProtocol {
		t.Fatalf("CLOSE %d, want 4402", code)
	}
}

func TestDataPast4MiBUnackedTowardASilentClientEndsThatSession4408(t *testing.T) {
	rs := defaults(t)
	n := ready(t, rs, nodeOpts{})
	s := open(t, rs, n, false)
	chunk := make([]byte, 64<<10)
	for range relayserver.SocketWindow/len(chunk) + 1 {
		n.frameOut(wire.FrameData, s.sid, chunk)
	}
	if code := n.expect(t, wire.FrameClose, s.sid).CloseCode(); code != wire.CodeTimeout {
		t.Fatalf("CLOSE %d, want 4408", code)
	}
	if code := <-s.c.closed; code != int(wire.CodeTimeout) {
		t.Fatalf("closed %d, want 4408", code)
	}
	if got := s.c.received.Load(); got != relayserver.SocketWindow {
		t.Fatalf("client got %d, want exactly 4 MiB", got)
	}
}

func TestOneMiBMessageIsForwardedAndOneByteMoreCloses1009(t *testing.T) {
	rs := defaults(t)
	n := ready(t, rs, nodeOpts{})
	s := open(t, rs, n, true)
	s.c.send(make([]byte, relayserver.MessageMax))
	if f := n.expect(t, wire.FrameData, s.sid); len(f.Payload) != relayserver.MessageMax {
		t.Fatalf("forwarded %d bytes", len(f.Payload))
	}
	s.c.send(make([]byte, relayserver.MessageMax+1))
	if code := <-s.c.closed; code != int(relayserver.CodeTooBig) {
		t.Fatalf("closed %d, want 1009", code)
	}
	if code := n.expect(t, wire.FrameClose, s.sid).CloseCode(); code != relayserver.CodeTooBig {
		t.Fatalf("CLOSE %d, want 1009", code)
	}
}

func TestPingGetsPongOnUplinksAndClients(t *testing.T) {
	rs := defaults(t)
	n := ready(t, rs, nodeOpts{})
	s := open(t, rs, n, true)
	n.sendText("ping")
	s.c.sendText("ping")
	if a, b := <-n.texts, <-s.c.texts; a != "pong" || b != "pong" {
		t.Fatalf("got %q and %q", a, b)
	}
}

func TestAnyOtherTextCloses1003(t *testing.T) {
	rs := defaults(t)
	n := ready(t, rs, nodeOpts{})
	s := open(t, rs, n, true)
	s.c.sendText("hello")
	if code := <-s.c.closed; code != int(relayserver.CodeUnsupported) {
		t.Fatalf("client closed %d, want 1003", code)
	}
	if code := n.expect(t, wire.FrameClose, s.sid).CloseCode(); code != relayserver.CodeUnsupported {
		t.Fatalf("CLOSE %d, want 1003", code)
	}
	n.sendText("hello")
	if code := <-n.closed; code != int(relayserver.CodeUnsupported) {
		t.Fatalf("uplink closed %d, want 1003", code)
	}
}

// stuckClient upgrades a client session by hand over raw TCP with a tiny receive buffer, then
// never reads again.
func stuckClient(t *testing.T, rs *relaytest.Server, nodeID string) net.Conn {
	t.Helper()
	addr := strings.TrimPrefix(rs.URL, "http://")
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	c.(*net.TCPConn).SetReadBuffer(4096)
	req := "GET /v1/client/" + nodeID + " HTTP/1.1\r\nHost: " + addr + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
	if _, err := c.Write([]byte(req)); err != nil {
		t.Fatal(err)
	}
	res, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil || res.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("upgrade: %v %v", res, err)
	}
	return c
}

func TestAPeerThatStopsReadingIsDroppedWithItsGoroutines(t *testing.T) {
	l := relayserver.DefaultLimits()
	l.WriteTimeout = 300 * time.Millisecond
	rs := relaytest.NewWithLimits(l)
	done := make(chan string, 16)
	rs.Relay.Hooks.OnSocketDone = func(nodeID, role string) { done <- role }
	rs.Start()
	t.Cleanup(rs.Close)
	n := ready(t, rs, nodeOpts{})
	stuckClient(t, rs, n.nodeID)
	sid := n.expect(t, wire.FrameOpen, 0).SID
	chunk := make([]byte, 64<<10)
	for range relayserver.SocketWindow/len(chunk) - 1 {
		n.frameOut(wire.FrameData, sid, chunk)
	}
	if role := <-done; role != "client" {
		t.Fatalf("socket done: %s, want the stuck client", role)
	}
	if code := n.closeOf(t, sid); code == 0 {
		t.Fatal("the node was not told the session ended")
	}
}

func TestWithAPublicOriginOtherHostsGet421AndOnlyThatOriginAuthenticates(t *testing.T) {
	rs := defaults(t)
	rs.Relay.PublicOrigin = "ws://relay.test"
	id, _ := ident.Generate(nil)
	u, _ := wire.WebSocketURL(rs.URL, "/v1/node/"+id.NodeID())
	_, res, err := websocket.Dial(context.Background(), u, &websocket.DialOptions{Host: "other.example"})
	if err == nil || res == nil || res.StatusCode != http.StatusMisdirectedRequest {
		t.Fatalf("Host other.example: %v, want 421 before upgrade", err)
	}
	wrong := node(t, rs, nodeOpts{host: "relay.test", origin: "ws://other.example"})
	if code := <-wrong.closed; code != int(wire.CodeRelayAuth) {
		t.Fatalf("signature over another origin closed %d, want 4403", code)
	}
	right := node(t, rs, nodeOpts{host: "relay.test", origin: "ws://relay.test"})
	if err := rs.WaitOnline(context.Background(), right.nodeID); err != nil {
		t.Fatal(err)
	}
}

func dialStatus(t *testing.T, rs *relaytest.Server, path string) int {
	t.Helper()
	u, _ := wire.WebSocketURL(rs.URL, path)
	ws, res, err := websocket.Dial(context.Background(), u, nil)
	if err == nil {
		t.Cleanup(func() { ws.CloseNow() })
		return http.StatusSwitchingProtocols
	}
	if res == nil {
		t.Fatal(err)
	}
	return res.StatusCode
}

func TestSocketsPastTheTotalAndPerAddressCapsGet429(t *testing.T) {
	for _, set := range []func(*relayserver.Server){
		func(s *relayserver.Server) { s.MaxSockets = 2 },
		func(s *relayserver.Server) { s.MaxPerIP = 2 },
	} {
		rs := defaults(t)
		set(rs.Relay)
		for range 2 {
			node(t, rs, nodeOpts{silent: true})
		}
		id, _ := ident.Generate(nil)
		if got := dialStatus(t, rs, "/v1/node/"+id.NodeID()); got != http.StatusTooManyRequests {
			t.Fatalf("third socket got %d, want 429", got)
		}
	}
}

func TestTheRealNodeEvictsTheOldestUnauthenticatedUplinkInsteadOfBeingLockedOut(t *testing.T) {
	rs := defaults(t)
	id, _ := ident.Generate(nil)
	var squatters []*fakeNode
	for range relayserver.DefaultMaxUnauthPerNode {
		squatters = append(squatters, nodeWith(t, rs, id, nodeOpts{silent: true}))
	}
	real := nodeWith(t, rs, id, nodeOpts{})
	if err := rs.WaitOnline(context.Background(), real.nodeID); err != nil {
		t.Fatal(err)
	}
	if code := <-squatters[0].closed; code != int(wire.CodeCaps) {
		t.Fatalf("oldest unauthenticated uplink closed %d, want 4429", code)
	}
}

func TestARoomIsFreedWhenItsLastSocketEnds(t *testing.T) {
	rs := relaytest.NewWithLimits(relayserver.DefaultLimits())
	done := make(chan string, 4)
	rs.Relay.Hooks.OnSocketDone = func(_, role string) { done <- role }
	rs.Start()
	t.Cleanup(rs.Close)
	n := ready(t, rs, nodeOpts{})
	if rs.Relay.Rooms() != 1 {
		t.Fatalf("rooms %d", rs.Relay.Rooms())
	}
	n.ws.Close(websocket.StatusNormalClosure, "")
	<-done
	if got := rs.Relay.Rooms(); got != 0 {
		t.Fatalf("rooms %d after the last socket, want 0", got)
	}
}

func TestAnUnauthenticatedUplinkMayNotSendMoreThanItsAnswer(t *testing.T) {
	rs := defaults(t)
	n := node(t, rs, nodeOpts{silent: true})
	n.send(make([]byte, relayserver.MessageMax+1))
	if code := <-n.closed; code != int(wire.CodeRelayAuth) {
		t.Fatalf("closed %d, want 4403 after at most 97 bytes", code)
	}
}
