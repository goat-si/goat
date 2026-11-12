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
	MessageMax   = 1 << 20
	SocketWindow = 4 << 20
	LightSession = 16 << 10
	// FirstMessageMax is the largest first message a client sends on a session (contract "Sessions").
	FirstMessageMax = 4096
	RelayHeadroom   = 64 << 10
	PendingMax      = 8
	ActiveMax       = 32
	challengeLen    = 32
	answerLen       = 96
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
	// OnEnd is called when the relay ends a socket with a close code (role "node" or "client"),
	// and OnWriteFailed when a socket's write failed or timed out (tests count exit paths).
	OnEnd         func(role string, code uint16)
	OnWriteFailed func(role string)
	// failWrite, when set, is asked before each data write to a socket (role, and for a client its
	// node id and session id) and fails that write as a timed-out one when it returns an error.
	failWrite func(nodeID, role string, sid uint32) error
	// counted, when set, is called once a session's bytes are in the traffic totals.
	counted func()
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
	// TrafficLog receives one line per session the node answered and the byte totals every
	// SummaryEvery (traffic.go); nil writes nothing. Set it before the relay serves.
	TrafficLog io.Writer
	// TrafficNodes are the node ids (full) that get totals and session lines in TrafficLog; the
	// relay-wide totals count every session. Set it before the relay serves.
	TrafficNodes map[string]bool

	queued, reading atomic.Int64
	traffic         traffic
	// handlers counts the socket handlers running; Close waits for them before the last summary.
	handlers sync.WaitGroup

	mu sync.Mutex
	// closing, once Close starts, refuses new sockets.
	closing bool
	// closeOnce makes Close run once; a concurrent caller waits for it.
	closeOnce sync.Once
	rooms     map[string]*room
	socks     map[*sock]struct{}
	total     int
	perIP     map[string]int
	shares    map[string]*source
	unauth    map[string][]*sock // unauthenticated uplinks per node, oldest first
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
	return &Server{Limits: l, rooms: map[string]*room{}, socks: map[*sock]struct{}{},
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

// shareLocked is ip's part of the budget, held once more.
func (s *Server) shareLocked(ip string) *source {
	src := s.shares[ip]
	if src == nil {
		src = &source{}
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
	defer s.handlers.Done()
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
	k.ws, k.out = ws, newOutq(ws, s.Limits.WriteTimeout, k.budget)
	if f := s.Hooks.OnWriteFailed; f != nil {
		k.out.onWriteFail = func() { f(k.roleName()) }
	}
	if f := s.Hooks.failWrite; f != nil {
		k.out.failWrite = func() error { return f(nodeID, k.roleName(), k.sid) }
	}
	s.mu.Lock()
	s.socks[k] = struct{}{}
	abort := s.closing
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
	if abort {
		// Close took its list of sockets before this one joined.
		ws.CloseNow()
	}
	if f := s.Hooks.OnSocketDone; f != nil {
		// Deferred first so it runs last, once release has given back the socket's room and share.
		defer func() {
			role := "client"
			if k.role == roleNode {
				role = "node"
			}
			f(nodeID, role)
		}()
	}
	if role == "client" {
		// After release, so a slow log never holds the socket's caps.
		defer func() {
			if k.sid != 0 {
				s.sessionDone(k)
			}
		}()
	}
	defer s.release(k)
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
	if s.closing || s.total >= orDefault(s.MaxSockets, DefaultMaxSockets) || s.perIP[k.ip] >= orDefault(s.MaxPerIP, DefaultMaxPerIP) {
		return false, nil
	}
	s.handlers.Add(1)
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

func (k *sock) roleName() string {
	if k.role == roleNode {
		return "node"
	}
	return "client"
}

func (s *Server) ended(k *sock, code uint16) {
	if f := s.Hooks.OnEnd; f != nil {
		f(k.roleName(), code)
	}
}

// Close aborts every socket. With a traffic log it waits, at most WriteTimeout, for the sessions
// it ends to report their bytes, then writes the totals one last time.
func (s *Server) Close() {
	s.closeOnce.Do(s.close)
}

func (s *Server) close() {
	s.mu.Lock()
	s.closing = true
	all := make([]*sock, 0, len(s.socks))
	for k := range s.socks {
		all = append(all, k)
	}
	s.mu.Unlock()
	// Marked before any abort: an uplink's abort ends its sessions too, and the shutdown ended them.
	for _, k := range all {
		if k.role == roleClient && s.TrafficLog != nil {
			k.room.mu.Lock()
			if !k.closed && k.endedBy == "" {
				k.endedBy, k.endCode = "relay", uint16(websocket.StatusGoingAway)
			}
			k.room.mu.Unlock()
		}
	}
	for _, k := range all {
		k.ws.CloseNow()
	}
	if s.TrafficLog != nil {
		done := make(chan struct{})
		go func() {
			s.handlers.Wait()
			close(done)
		}()
		s.traffic.wait(done, s.Limits.WriteTimeout)
	}
	s.trafficStop()
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
	sid     uint32
	order   uint64
	pending bool
	// pendingSent counts the messages the client sent before the node answered.
	pendingSent int
	// held is the uplink whose queue holds this client's CLOSE reservation (nil once it is sent);
	// closeWire, on an uplink, is the wire bytes of the CLOSE frames reserved there.
	held      *sock
	closeWire uint64
	upEnd     uint64
	upUnacked uint64
	// Traffic (client): the session's tally and the uplink queue that also holds it, whether the
	// node answered, and when and how the session began and ended.
	tally             *sessionTally
	tallyQ            *outq
	answered          bool
	admitted, endedAt time.Time
	endedBy           string
	endCode           uint16
}

// room is one node's uplink and its sessions.
type room struct {
	srv    *Server
	nodeID string
	refs   int // guarded by srv.mu

	mu      sync.Mutex
	uplink  *sock
	clients map[uint32]*sock
	// sid is the last session id this room handed out. The room outlives its uplink only while
	// clients remain, so a node never sees ids from before its uplink connection's room.
	sid   uint32
	order uint64
}

// nextSid hands out the next session id that is not 0 and not live in this room; past
// 0xffffffff it wraps to 1. Called with rm.mu held.
func (rm *room) nextSid() uint32 {
	for {
		if rm.sid++; rm.sid == 0 {
			continue
		}
		if _, live := rm.clients[rm.sid]; !live {
			return rm.sid
		}
	}
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
		rm.srv.ended(k, wire.CodeOffline)
		k.out.close(wire.CodeOffline)
		return false
	}
	// Admission pays: the session's OPEN and its CLOSE are reserved on the uplink's queue now, so
	// a CLOSE always fits and control frames never end an uplink. A node that cannot take more
	// refuses the new client 4429 and queues nothing.
	up := rm.uplink
	if up.sent-up.acked+up.closeWire+sessionFrameWire > SocketWindow+RelayHeadroom || !up.out.reserve(2*sessionFrameCost) {
		k.closed = true
		rm.srv.ended(k, wire.CodeCaps)
		k.out.close(wire.CodeCaps)
		return false
	}
	k.held = up
	up.closeWire += closeFrameWire
	k.sid = rm.nextSid()
	k.admitted = rm.srv.traffic.clock()
	rm.srv.trafficStart()
	rm.srv.trackSession(k, up)
	rm.order++
	k.order = rm.order
	k.pending = true
	rm.makePendingRoom(k.ip)
	rm.clients[k.sid] = k
	k.deadline = time.AfterFunc(rm.srv.Limits.PendingTimeout, func() {
		rm.mu.Lock()
		defer rm.mu.Unlock()
		if !k.closed && k.pending {
			rm.fail(k, wire.CodeTimeout)
		}
	})
	rm.armIdle(k)
	open := wire.Frame{Type: wire.FrameOpen, SID: k.sid}.Encode()
	up.out.pushReserved(open, sessionFrameCost)
	up.sent += uint64(len(open))
	return true
}

// Wire bytes of a session's OPEN and CLOSE frames toward the uplink.
const (
	closeFrameWire   = wire.HeaderLen + 2
	sessionFrameWire = wire.HeaderLen + closeFrameWire
)

// makePendingRoom makes room for a pending session from ip: past PendingMax per node, the oldest
// pending session of the address holding the most ends 4429 (ip's own on a tie), so one address
// opening many sessions cannot displace another's, while one machine may still open several at
// once (an SSH client or several forwarded connections).
func (rm *room) makePendingRoom(ip string) {
	for {
		bySource := map[string][]*sock{}
		total := 0
		for _, c := range rm.clients {
			if c.pending {
				bySource[c.ip] = append(bySource[c.ip], c)
				total++
			}
		}
		if total < PendingMax {
			return
		}
		victims := bySource[ip]
		for _, list := range bySource {
			if len(list) > len(victims) {
				victims = list
			}
		}
		oldest := victims[0]
		for _, c := range victims {
			if c.order < oldest.order {
				oldest = c
			}
		}
		rm.endSession(oldest, wire.CodeCaps)
	}
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
		rm.closeAs(c, sendable(f.CloseCode()), "node")
		// The node closed it, so no CLOSE goes back: give the reservation back.
		if c.held == k {
			c.held = nil
			k.out.unreserve(sessionFrameCost)
			k.closeWire -= closeFrameWire
		}
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
		c.answered = true
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
		rm.closeAs(c, wire.CodeOffline, "uplink")
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
	// Until the node answers, a client may send one message of at most 4096 bytes, its first
	// (contract "Sessions"): the eight pending sessions a node may have hold little of its share.
	if c.pending {
		if c.pendingSent++; c.pendingSent > 1 || len(payload) > FirstMessageMax {
			rm.endSession(c, wire.CodeTimeout)
			return
		}
	}
	// Data toward an uplink never ends another queue: when it does not fit, only its session ends.
	if up.sent-up.acked+uint64(frameLen) > limit || qTotal+cost > qLimit || !up.out.offerFrame(c.sid, payload) {
		rm.endSession(c, wire.CodeTimeout)
		return
	}
	up.sent += uint64(frameLen)
	c.upEnd = up.sent
	c.upUnacked = mine
}

// sendClose tells the node a client session ended, from the reservation made when it was
// admitted, so it always fits.
func (rm *room) sendClose(c *sock, code uint16) {
	up := c.held
	c.held = nil
	if up == nil || up != rm.uplink {
		return
	}
	f := wire.CloseFrame(c.sid, code).Encode()
	up.out.pushReserved(f, sessionFrameCost)
	up.sent += uint64(len(f))
	up.closeWire -= closeFrameWire
}

// endSession closes a client with code and tells the node.
func (rm *room) endSession(c *sock, code uint16) {
	rm.closeSock(c, code)
	if rm.uplink != nil {
		rm.sendClose(c, code)
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
		rm.closeAs(c, wire.CodeOffline, "uplink")
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
	if k.role == roleClient {
		k.endedAt = rm.srv.traffic.clock()
		if k.endedBy == "" {
			k.endedBy, k.endCode = "relay", code
		}
		if q := k.tallyQ; q != nil {
			k.tallyQ = nil
			q.endSession(k.sid)
		}
	}
	rm.srv.ended(k, code)
	k.out.close(code)
}

// closeAs closes a client socket, recording who ended the session ("client", "node" or "uplink").
func (rm *room) closeAs(k *sock, code uint16, by string) {
	if !k.closed && k.endedBy == "" {
		k.endedBy, k.endCode = by, code
	}
	rm.closeSock(k, code)
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
	// The line keeps the client's own code (1006 for an abort), not the one a close frame may carry.
	if k.endedBy == "" {
		k.endedBy, k.endCode = "client", code
	}
	rm.closeSock(k, sendable(code))
	if code < 1000 || code > 4999 {
		code = 1000
	}
	if rm.uplink != nil {
		rm.sendClose(k, code)
	}
}

// sendable is a code a close frame may carry.
func sendable(code uint16) uint16 {
	if code == 1000 || code >= 3000 && code <= 4999 {
		return code
	}
	return 1000
}
