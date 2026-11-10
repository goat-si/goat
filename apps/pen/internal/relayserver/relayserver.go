// Package relayserver is the Pen relay in Go: the same contract as infra/pen-relay (uplink auth with
// origin binding, the session mux, caps, timeouts, backpressure and acks), for running a relay on
// any machine with "pen relay serve".
package relayserver

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"io"
	"net"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// Contract limits.
const (
	MessageMax    = 1 << 20
	SocketWindow  = 4 << 20
	LightSession  = 16 << 10
	RelayHeadroom = 64 << 10
	PendingMax    = 8
	ActiveMax     = 32
	challengeLen  = 32
	answerLen     = 96
	// queueSlack is what a socket's outbound queue may hold past the contract windows (pongs).
	queueSlack = 64 << 10
	// maxQueuedPongs caps pongs waiting behind a slow write; more pings get no pong until it drains.
	maxQueuedPongs = 8
)

// Close codes the relay sends besides the wire package's.
const (
	CodeUnsupported uint16 = 1003
	CodeTooBig      uint16 = 1009
)

// Version is what /healthz reports.
const Version = "pen-relay/1.0"

// Limits are the relay's timeouts.
type Limits struct {
	AuthTimeout    time.Duration
	PendingTimeout time.Duration
	IdleTimeout    time.Duration
	// WriteTimeout bounds one write and a closing handshake; a socket that stalls longer is dropped.
	WriteTimeout time.Duration
}

// DefaultLimits are the contract's: 10 s auth, 10 s pending, 90 s idle.
func DefaultLimits() Limits {
	return Limits{AuthTimeout: 10 * time.Second, PendingTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, WriteTimeout: 10 * time.Second}
}

// Hooks let tests and wrappers observe the relay.
type Hooks struct {
	// OnUplink is called after an uplink authenticates.
	OnUplink func(nodeID string)
	// OnAck is called with every accepted ack on an uplink.
	OnAck func(nodeID string, total uint64)
	// OnBadAck is called when an ack closes a socket 4402.
	OnBadAck func()
	// OnSocketDone is called when a socket's handler, reader and writer have all ended.
	OnSocketDone func(nodeID, role string)
	// OnMessage is called with each message a socket sent (role "node" or "client"), before the
	// relay handles it; blocking here holds that socket's later messages too (tests hold forwarding
	// or pongs).
	OnMessage func(nodeID, role string, text bool)
}

// Server is a relay. It is an http.Handler.
type Server struct {
	Limits Limits
	// PublicOrigin is the origin uplinks sign (wss://host); requests for any other Host get 421.
	// Empty only for loopback and tests, where the origin follows each request.
	PublicOrigin string
	Hooks        Hooks
	// MaxSockets, MaxPerIP and MaxUnauthPerNode cap all sockets, one source address's sockets and
	// one node id's unauthenticated uplinks; past them a request gets HTTP 429 (0 means the default).
	MaxSockets       int
	MaxPerIP         int
	MaxUnauthPerNode int
	// MaxQueued caps the memory all sockets' queued and partly read messages hold together, so
	// slow readers on many sockets cannot grow the process past its memory limit (0 means
	// DefaultMaxQueued). MaxQueuedPerSource caps one source address's part of it, so the
	// sockets of one source that stop reading cannot fill it for everyone (0 means
	// DefaultMaxQueuedPerSource, never more than MaxQueued).
	MaxQueued          int
	MaxQueuedPerSource int
	// MaxReading caps what messages being read hold past each socket's read allowance (0 means
	// DefaultMaxReading); one source holds at most an eighth of it.
	MaxReading int

	// clock replaces time.Now in tests.
	clock func() time.Time

	queued, reading atomic.Int64

	mu     sync.Mutex
	rooms  map[string]*room
	sids   map[string]uint32
	socks  map[*sock]struct{}
	total  int
	perIP  map[string]int
	shares map[string]*source
	unauth map[string][]*sock // unauthenticated uplinks per node, oldest first
}

// Default caps.
const (
	DefaultMaxSockets         = 4096
	DefaultMaxPerIP           = 64
	DefaultMaxUnauthPerNode   = 4
	DefaultMaxQueued          = 192 << 20
	DefaultMaxQueuedPerSource = 16 << 20
	DefaultMaxReading         = 32 << 20
)

func orDefault(v, d int) int {
	if v > 0 {
		return v
	}
	return d
}

// New builds a relay with limits.
func New(l Limits) *Server {
	d := DefaultLimits()
	for _, f := range []struct {
		v *time.Duration
		d time.Duration
	}{
		{&l.AuthTimeout, d.AuthTimeout}, {&l.PendingTimeout, d.PendingTimeout},
		{&l.IdleTimeout, d.IdleTimeout}, {&l.WriteTimeout, d.WriteTimeout},
	} {
		if *f.v <= 0 {
			*f.v = f.d
		}
	}
	return &Server{Limits: l, rooms: map[string]*room{}, sids: map[string]uint32{}, socks: map[*sock]struct{}{},
		perIP: map[string]int{}, shares: map[string]*source{}, unauth: map[string][]*sock{}}
}

// sourceKey is what the per-source cap counts: the IPv4 address, or the IPv6 /64, since one
// IPv6 host usually holds a whole /64.
func sourceKey(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	if i := strings.IndexByte(host, '%'); i >= 0 {
		host = host[:i]
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return host
	}
	if v4 := ip.To4(); v4 != nil {
		return v4.String()
	}
	return ip.Mask(net.CIDRMask(64, 128)).String() + "/64"
}

var route = regexp.MustCompile(`^/v1/(node|client)/([^/]*)$`)

// Queued is the memory every socket's queued and partly read messages hold now.
func (s *Server) Queued() int64 { return s.queued.Load() }

func (s *Server) maxQueued() int64 { return int64(orDefault(s.MaxQueued, DefaultMaxQueued)) }

func (s *Server) maxPerSource() int64 {
	return min(int64(orDefault(s.MaxQueuedPerSource, DefaultMaxQueuedPerSource)), s.maxQueued())
}

func (s *Server) maxReading() int64 { return int64(orDefault(s.MaxReading, DefaultMaxReading)) }

// Reading is what messages being read hold past their sockets' read allowance now.
func (s *Server) Reading() int64 { return s.reading.Load() }

// makeRoom ends the queue a full relay gives up first (rank.endsBefore) among the queues of within,
// or of every source when within is nil; it reports whether that gave anything back. It ends none
// when self ranks first: then self's offer is refused and its own session ends.
func (s *Server) makeRoom(within *source, self *outq) bool {
	s.mu.Lock()
	now := time.Now()
	if s.clock != nil {
		now = s.clock()
	}
	var victim *outq
	var worst rank
	consider := func(src *source) {
		for q := range src.queues {
			if r, ok := q.rank(now); ok && (victim == nil || r.endsBefore(worst)) {
				victim, worst = q, r
			}
		}
	}
	if within != nil {
		consider(within)
	} else {
		for _, src := range s.shares {
			consider(src)
		}
	}
	s.mu.Unlock()
	return victim != nil && victim != self && victim.abort()
}

// shareLocked is ip's part of the budget, held once more.
func (s *Server) shareLocked(ip string) *source {
	src := s.shares[ip]
	if src == nil {
		src = &source{queues: map[*outq]struct{}{}}
		s.shares[ip] = src
	}
	src.refs++
	return src
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// With a public origin, the request's Host must name it: uplinks sign that origin, and a relay
	// reached under another name must not let a node sign for it.
	if s.PublicOrigin != "" && !s.hostMatches(r.Host) {
		http.Error(w, "misdirected request", http.StatusMisdirectedRequest)
		return
	}
	if r.URL.Path == "/healthz" {
		w.Header().Set("content-type", "application/json")
		w.Header().Set("cache-control", "no-store")
		w.Write([]byte(`{"ok":true,"version":"` + Version + `"}`))
		return
	}
	m := route.FindStringSubmatch(r.URL.Path)
	if m == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	role, nodeID := m[1], m[2]
	if !ident.ValidNodeID(nodeID) {
		http.Error(w, "bad node id", http.StatusBadRequest)
		return
	}
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		http.Error(w, "websocket upgrade required", http.StatusUpgradeRequired)
		return
	}
	k := &sock{srv: s, nodeID: nodeID, ip: sourceKey(r.RemoteAddr)}
	ok, victim := s.reserve(k, role == "node")
	if !ok {
		http.Error(w, "too many sockets", http.StatusTooManyRequests)
		return
	}
	if victim != nil {
		s.evict(victim)
	}
	// net/http clears its read and write deadlines when Accept hijacks the connection; an upgraded
	// socket keeps its own idle and write timeouts.
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		CompressionMode: websocket.CompressionDisabled,
		// Browsers' Origin headers are not checked: the Noise layer and the uplink challenge
		// authenticate, and clients may run on any page.
		InsecureSkipVerify: true,
	})
	if err != nil {
		s.unreserve(k)
		return
	}
	ws.SetReadLimit(-1)
	origin := s.PublicOrigin
	if origin == "" {
		// Loopback and tests only: the origin follows the request (pen relay serve requires a
		// public origin on any other address).
		scheme := "ws"
		if r.TLS != nil {
			scheme = "wss"
		}
		origin, _ = wire.RelayOrigin(scheme + "://" + r.Host)
	}
	k.ws, k.out = ws, newOutq(ws, s.Limits.WriteTimeout, k.budget, role == "node")
	s.mu.Lock()
	s.socks[k] = struct{}{}
	rm := s.rooms[nodeID]
	if rm == nil {
		rm = &room{srv: s, nodeID: nodeID, clients: map[uint32]*sock{}}
		s.rooms[nodeID] = rm
	}
	rm.refs++
	// role is set with room under s.mu: evict reads room under s.mu and then role, so it never
	// sees a node socket without its role.
	k.role = roleClient
	if role == "node" {
		k.role = roleNode
	}
	k.room = rm
	evicted := k.evicted
	s.mu.Unlock()
	defer s.release(k)
	if f := s.Hooks.OnSocketDone; f != nil {
		defer func() {
			role := "client"
			if k.role == roleNode {
				role = "node"
			}
			f(nodeID, role)
		}()
	}
	if role == "node" {
		rm.acceptUplink(k, origin)
		if evicted {
			// A newer uplink for this node took its place while this one was upgrading.
			rm.mu.Lock()
			rm.fail(k, wire.CodeCaps)
			rm.mu.Unlock()
		}
	} else {
		if !rm.acceptClient(k) {
			k.out.wait()
			return
		}
	}
	k.readLoop()
	k.out.wait()
}

// reserve counts a socket against the caps before it is accepted. An uplink past the
// unauthenticated cap for its node takes the place of the oldest one, which reserve returns: a
// squatter holding unanswered uplinks must not lock the real node out.
func (s *Server) reserve(k *sock, uplink bool) (bool, *sock) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.total >= orDefault(s.MaxSockets, DefaultMaxSockets) || s.perIP[k.ip] >= orDefault(s.MaxPerIP, DefaultMaxPerIP) {
		return false, nil
	}
	s.total++
	s.perIP[k.ip]++
	k.budget = &budget{srv: s, src: s.shareLocked(k.ip)}
	if !uplink {
		return true, nil
	}
	var victim *sock
	if q := s.unauth[k.nodeID]; len(q) >= orDefault(s.MaxUnauthPerNode, DefaultMaxUnauthPerNode) {
		victim = q[0]
		s.authedLocked(victim)
		victim.evicted = true
	}
	k.unauthCounted = true
	s.unauth[k.nodeID] = append(s.unauth[k.nodeID], k)
	return true, victim
}

// evict closes an unauthenticated uplink 4429 unless it authenticated meanwhile; one still
// upgrading closes itself when it joins its room.
func (s *Server) evict(v *sock) {
	s.mu.Lock()
	rm := v.room
	s.mu.Unlock()
	if rm == nil {
		return
	}
	rm.mu.Lock()
	defer rm.mu.Unlock()
	if !v.closed && !v.authed {
		rm.fail(v, wire.CodeCaps)
	}
}

// unreserve gives back what reserve counted.
func (s *Server) unreserve(k *sock) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.unreserveLocked(k)
}

func (s *Server) unreserveLocked(k *sock) {
	s.total--
	if s.perIP[k.ip]--; s.perIP[k.ip] <= 0 {
		delete(s.perIP, k.ip)
	}
	src := k.budget.src
	if src.refs--; src.refs == 0 {
		delete(s.shares, k.ip)
	}
	s.authedLocked(k)
}

// authedLocked stops counting k as an unauthenticated uplink.
func (s *Server) authedLocked(k *sock) {
	if !k.unauthCounted {
		return
	}
	k.unauthCounted = false
	q := slices.DeleteFunc(s.unauth[k.nodeID], func(x *sock) bool { return x == k })
	if len(q) == 0 {
		delete(s.unauth, k.nodeID)
	} else {
		s.unauth[k.nodeID] = q
	}
}

func (s *Server) release(k *sock) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.unreserveLocked(k)
	delete(s.socks, k)
	if k.room.refs--; k.room.refs == 0 && s.rooms[k.nodeID] == k.room {
		delete(s.rooms, k.nodeID)
	}
}

// Rooms is the number of nodes with open sockets.
func (s *Server) Rooms() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.rooms)
}

// hostMatches reports whether a request's Host names the public origin.
func (s *Server) hostMatches(host string) bool {
	scheme, _, _ := strings.Cut(s.PublicOrigin, "://")
	o, err := wire.RelayOrigin(scheme + "://" + host)
	return err == nil && o == s.PublicOrigin
}

// nextSid hands out session ids per node; they are never reused while this process runs.
func (s *Server) nextSid(nodeID string) uint32 {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sids[nodeID]++
	return s.sids[nodeID]
}

// Close aborts every socket.
func (s *Server) Close() {
	s.mu.Lock()
	all := make([]*sock, 0, len(s.socks))
	for k := range s.socks {
		all = append(all, k)
	}
	s.mu.Unlock()
	for _, k := range all {
		k.ws.CloseNow()
	}
}

// DropUplink aborts nodeID's uplink socket as a failing network would.
func (s *Server) DropUplink(nodeID string) bool {
	s.mu.Lock()
	rm := s.rooms[nodeID]
	s.mu.Unlock()
	if rm == nil {
		return false
	}
	rm.mu.Lock()
	up := rm.uplink
	rm.mu.Unlock()
	if up == nil {
		return false
	}
	up.ws.CloseNow()
	return true
}

// Online reports whether nodeID has an authenticated uplink.
func (s *Server) Online(nodeID string) bool {
	s.mu.Lock()
	rm := s.rooms[nodeID]
	s.mu.Unlock()
	if rm == nil {
		return false
	}
	rm.mu.Lock()
	defer rm.mu.Unlock()
	return rm.uplink != nil
}

const (
	roleNode = iota + 1
	roleClient
)

// sock is one accepted WebSocket. Fields below the line are guarded by room.mu.
type sock struct {
	srv    *Server
	ws     *websocket.Conn
	room   *room
	nodeID string
	ip     string
	// unauthCounted and evicted are guarded by srv.mu.
	unauthCounted bool
	evicted       bool
	role          int
	out           *outq
	budget        *budget

	sent, acked uint64
	closed      bool
	deadline    *time.Timer
	idle        *time.Timer
	// uplink
	authed    bool
	origin    string
	challenge []byte
	// client
	sid       uint32
	pending   bool
	upEnd     uint64
	upUnacked uint64
}

// room is one node's uplink and its sessions.
type room struct {
	srv    *Server
	nodeID string
	refs   int // guarded by srv.mu

	mu      sync.Mutex
	uplink  *sock
	clients map[uint32]*sock
}

func (rm *room) armIdle(k *sock) {
	k.idle = time.AfterFunc(rm.srv.Limits.IdleTimeout, func() {
		rm.mu.Lock()
		defer rm.mu.Unlock()
		if !k.closed {
			rm.fail(k, wire.CodeTimeout)
		}
	})
}

func (rm *room) acceptUplink(k *sock, origin string) {
	challenge := make([]byte, challengeLen)
	rand.Read(challenge)
	rm.mu.Lock()
	defer rm.mu.Unlock()
	k.origin, k.challenge = origin, challenge
	k.sent = challengeLen
	k.out.binary(challenge)
	k.deadline = time.AfterFunc(rm.srv.Limits.AuthTimeout, func() {
		rm.mu.Lock()
		defer rm.mu.Unlock()
		if !k.closed && !k.authed {
			rm.fail(k, wire.CodeRelayAuth)
		}
	})
	rm.armIdle(k)
}

// acceptClient opens a session, or closes the socket 4404 at once when the node is offline.
func (rm *room) acceptClient(k *sock) bool {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	if rm.uplink == nil {
		k.closed = true
		k.out.close(wire.CodeOffline)
		return false
	}
	k.sid = rm.srv.nextSid(rm.nodeID)
	k.pending = true
	var pending []*sock
	for _, c := range rm.clients {
		if c.pending {
			pending = append(pending, c)
		}
	}
	for len(pending) >= PendingMax {
		oldest := pending[0]
		at := 0
		for i, c := range pending {
			if c.sid < oldest.sid {
				oldest, at = c, i
			}
		}
		rm.endSession(oldest, wire.CodeCaps)
		pending = append(pending[:at], pending[at+1:]...)
	}
	rm.clients[k.sid] = k
	k.deadline = time.AfterFunc(rm.srv.Limits.PendingTimeout, func() {
		rm.mu.Lock()
		defer rm.mu.Unlock()
		if !k.closed && k.pending {
			rm.fail(k, wire.CodeTimeout)
		}
	})
	rm.armIdle(k)
	if rm.uplink != nil {
		rm.sendRelayFrame(wire.Frame{Type: wire.FrameOpen, SID: k.sid})
	}
	return true
}

func (k *sock) readLoop() {
	ctx := context.Background()
	for {
		typ, rd, err := k.ws.Reader(ctx)
		if err != nil {
			k.room.peerGone(k, closeCode(err))
			return
		}
		// Until it authenticates an uplink may send only its 96-byte answer. Only this goroutine
		// sets authed, so reading it here needs no lock.
		limit := int64(MessageMax)
		preAuth := k.role == roleNode && !k.authed
		if preAuth {
			limit = answerLen
		}
		data, err := readMessage(io.LimitReader(rd, limit+1), int(limit), k.budget)
		if errors.Is(err, errOverBudget) {
			k.room.mu.Lock()
			if !k.closed {
				k.room.fail(k, wire.CodeTimeout)
			}
			k.room.mu.Unlock()
			return
		}
		if err != nil {
			k.room.peerGone(k, closeCode(err))
			return
		}
		stop := k.handle(typ, data, preAuth)
		k.budget.countRead(-readCharge(cap(data)))
		if stop {
			return
		}
	}
}

// handle passes one message to the room; it reports whether the socket is done.
func (k *sock) handle(typ websocket.MessageType, data []byte, preAuth bool) bool {
	if f := k.srv.Hooks.OnMessage; f != nil {
		role := "client"
		if k.role == roleNode {
			role = "node"
		}
		f(k.nodeID, role, typ == websocket.MessageText)
	}
	rm := k.room
	rm.mu.Lock()
	defer rm.mu.Unlock()
	if k.closed {
		return true
	}
	if preAuth && len(data) > answerLen {
		rm.fail(k, wire.CodeRelayAuth)
		return true
	}
	if len(data) > MessageMax {
		rm.fail(k, CodeTooBig)
		return true
	}
	if typ == websocket.MessageText {
		rm.onText(k, string(data))
	} else if k.role == roleClient {
		rm.onClientData(k, data)
	} else if !k.authed {
		rm.authenticate(k, data)
	} else {
		rm.onUplinkFrame(k, data)
	}
	return false
}

func closeCode(err error) uint16 {
	if c := websocket.CloseStatus(err); c != -1 {
		return uint16(c)
	}
	return 1006
}

func (rm *room) authenticate(k *sock, answer []byte) {
	ok := len(answer) == answerLen && ident.NodeID(answer[:32]) == k.nodeID &&
		ed25519.Verify(answer[:32], wire.ChallengeMessage(k.origin, k.nodeID, k.challenge), answer[32:])
	if !ok {
		rm.fail(k, wire.CodeRelayAuth)
		return
	}
	if old := rm.uplink; old != nil {
		rm.dropUplink(old, wire.CodeReplaced)
	}
	k.authed, k.challenge = true, nil
	k.deadline.Stop()
	rm.srv.mu.Lock()
	rm.srv.authedLocked(k)
	rm.srv.mu.Unlock()
	rm.uplink = k
	if f := rm.srv.Hooks.OnUplink; f != nil {
		f(rm.nodeID)
	}
}

func (rm *room) onText(k *sock, text string) {
	if text == "ping" {
		k.idle.Reset(rm.srv.Limits.IdleTimeout)
		k.out.text("pong")
		return
	}
	if !strings.HasPrefix(text, "a:") {
		rm.fail(k, CodeUnsupported)
		return
	}
	n, ok := wire.ParseAck(text)
	if !ok || n < k.acked || n > k.sent {
		if f := rm.srv.Hooks.OnBadAck; f != nil {
			f()
		}
		rm.fail(k, wire.CodeRelayProtocol)
		return
	}
	k.acked = n
	if k.role == roleNode {
		if f := rm.srv.Hooks.OnAck; f != nil {
			f(rm.nodeID, n)
		}
	}
}

func (rm *room) onUplinkFrame(k *sock, b []byte) {
	f, err := wire.DecodeFrame(b)
	if err == nil && f.Type == wire.FrameData {
		if c := rm.clients[f.SID]; c != nil {
			rm.toClient(c, f.Payload)
		}
		return
	}
	if err != nil || f.Type != wire.FrameClose {
		rm.dropUplink(k, wire.CodeRelayProtocol)
		return
	}
	if c := rm.clients[f.SID]; c != nil {
		rm.closeSock(c, sendable(f.CloseCode()))
	}
}

func (rm *room) toClient(c *sock, payload []byte) {
	if c.pending {
		active := 0
		for _, o := range rm.clients {
			if !o.pending {
				active++
			}
		}
		if active >= ActiveMax {
			rm.endSession(c, wire.CodeCaps)
			return
		}
		c.pending = false
		c.deadline.Stop()
	}
	if c.sent-c.acked+uint64(len(payload)) > SocketWindow {
		rm.endSession(c, wire.CodeTimeout)
		return
	}
	// A full budget or source share ends the session whose client is not reading: its queue holds
	// the memory.
	if !c.out.offer(payload, 0) {
		rm.endSession(c, wire.CodeTimeout)
		return
	}
	c.sent += uint64(len(payload))
}

func (rm *room) onClientData(c *sock, payload []byte) {
	up := rm.uplink
	if up == nil {
		rm.closeSock(c, wire.CodeOffline)
		return
	}
	frameLen := wire.HeaderLen + len(payload)
	if up.acked >= c.upEnd {
		c.upUnacked = 0
	}
	mine := c.upUnacked + uint64(frameLen)
	others := max(1, len(rm.clients)-1)
	limit := uint64(SocketWindow)
	if mine > LightSession {
		limit = uint64(SocketWindow - LightSession*others)
	}
	// The same fair share applies to what the uplink's queue holds, where each frame also costs
	// itemOverhead: a flood of empty frames ends its own session before the queue overflows.
	cost := allocSize(frameLen) + itemOverhead
	qMine, qTotal := up.out.queued(c.sid)
	qLimit := SocketWindow
	if qMine+cost > LightSession {
		qLimit = SocketWindow - LightSession*others
	}
	if up.sent-up.acked+uint64(frameLen) > limit || qTotal+cost > qLimit || !up.out.offerFrame(c.sid, payload) {
		rm.endSession(c, wire.CodeTimeout)
		return
	}
	up.sent += uint64(frameLen)
	c.upEnd = up.sent
	c.upUnacked = mine
}

// sendRelayFrame sends OPEN or CLOSE, which may use RelayHeadroom past the window.
func (rm *room) sendRelayFrame(f wire.Frame) {
	up := rm.uplink
	b := f.Encode()
	if up.sent-up.acked+uint64(len(b)) > SocketWindow+RelayHeadroom {
		rm.dropUplink(up, wire.CodeTimeout)
		return
	}
	up.out.binary(b)
	up.sent += uint64(len(b))
}

// endSession closes a client with code and tells the node.
func (rm *room) endSession(c *sock, code uint16) {
	rm.closeSock(c, code)
	if rm.uplink != nil {
		rm.sendRelayFrame(wire.CloseFrame(c.sid, code))
	}
}

func (rm *room) dropUplink(k *sock, code uint16) {
	current := rm.uplink == k
	rm.closeSock(k, code)
	if !current {
		return
	}
	rm.uplink = nil
	for _, c := range rm.clients {
		rm.closeSock(c, wire.CodeOffline)
	}
}

func (rm *room) fail(k *sock, code uint16) {
	if k.role == roleNode {
		rm.dropUplink(k, code)
	} else {
		rm.endSession(k, code)
	}
}

func (rm *room) closeSock(k *sock, code uint16) {
	if k.closed {
		return
	}
	k.closed = true
	if k.deadline != nil {
		k.deadline.Stop()
	}
	if k.idle != nil {
		k.idle.Stop()
	}
	if k.role == roleClient && rm.clients[k.sid] == k {
		delete(rm.clients, k.sid)
	}
	k.out.close(code)
}

func (rm *room) peerGone(k *sock, code uint16) {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	if k.closed {
		return
	}
	if k.role == roleNode {
		rm.dropUplink(k, wire.CodeOffline)
		return
	}
	rm.closeSock(k, sendable(code))
	if code < 1000 || code > 4999 {
		code = 1000
	}
	if rm.uplink != nil {
		rm.sendRelayFrame(wire.CloseFrame(k.sid, code))
	}
}

// sendable is a code a close frame may carry.
func sendable(code uint16) uint16 {
	if code == 1000 || code >= 3000 && code <= 4999 {
		return code
	}
	return 1000
}
