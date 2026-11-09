// Package relaytest is an in-process stand-in for the Pen relay (uplink auth, the mux and ack checks)
// for hermetic tests. It enforces no caps, timeouts or backpressure.
package relaytest

import (
	"context"
	"errors"
	"crypto/ed25519"
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// Server is a stand-in relay.
type Server struct {
	URL  string
	http *httptest.Server

	mu     sync.Mutex
	nodes  map[string]*uplink
	online map[string]chan struct{}
	// BadAcks counts sockets closed 4402 for an ack that decreased or exceeded what was sent.
	BadAcks atomic.Int64
}

type sock struct {
	ws    *websocket.Conn
	sent  atomic.Uint64
	acked uint64
	acks  chan uint64
}

func newSock(ws *websocket.Conn) *sock { return &sock{ws: ws, acks: make(chan uint64, 64)} }

func (k *sock) send(ctx context.Context, p []byte) error {
	k.sent.Add(uint64(len(p)))
	return k.ws.Write(ctx, websocket.MessageBinary, p)
}

func (k *sock) closeAsync(code uint16) { go k.ws.Close(websocket.StatusCode(code), "") }

// text handles a text message; false means the socket was closed for it.
func (s *Server) text(ctx context.Context, k *sock, p []byte) bool {
	if string(p) == "ping" {
		k.ws.Write(ctx, websocket.MessageText, []byte("pong"))
		return true
	}
	n, ok := wire.ParseAck(string(p))
	if !ok {
		k.closeAsync(1003)
		return false
	}
	if n < k.acked || n > k.sent.Load() {
		s.BadAcks.Add(1)
		k.closeAsync(wire.CodeRelayProtocol)
		return false
	}
	k.acked = n
	select {
	case k.acks <- n:
	default:
	}
	return true
}

type uplink struct {
	k       *sock
	nextSID uint32
	clients map[uint32]*sock
}

// New starts a relay on 127.0.0.1.
func New() *Server {
	s := NewUnstarted()
	s.http = httptest.NewServer(s.Handler())
	s.URL = s.http.URL
	return s
}

// NewUnstarted builds a relay for use as an http.Handler.
func NewUnstarted() *Server {
	return &Server{nodes: map[string]*uplink{}, online: map[string]chan struct{}{}}
}

// onlineLocked returns the channel closed when nodeID's next uplink registers. Callers hold s.mu.
func (s *Server) onlineLocked(nodeID string) chan struct{} {
	ch := s.online[nodeID]
	if ch == nil {
		ch = make(chan struct{})
		s.online[nodeID] = ch
	}
	return ch
}

// WaitOnline returns once nodeID has an authenticated uplink.
func (s *Server) WaitOnline(ctx context.Context, nodeID string) error {
	s.mu.Lock()
	if s.nodes[nodeID] != nil {
		s.mu.Unlock()
		return nil
	}
	ch := s.onlineLocked(nodeID)
	s.mu.Unlock()
	select {
	case <-ch:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Handler serves the relay routes.
func (s *Server) Handler() http.Handler { return http.HandlerFunc(s.serve) }

// Close stops the relay and its sockets.
func (s *Server) Close() {
	s.mu.Lock()
	for _, u := range s.nodes {
		u.k.ws.CloseNow()
	}
	s.mu.Unlock()
	if s.http != nil {
		s.http.CloseClientConnections()
		s.http.Close()
	}
}

// DropUplink aborts nodeID's uplink socket as a failing network would, ending its sessions.
func (s *Server) DropUplink(nodeID string) bool {
	s.mu.Lock()
	u := s.nodes[nodeID]
	s.mu.Unlock()
	if u == nil {
		return false
	}
	u.k.ws.CloseNow()
	return true
}

// NextUplinkAck returns the next cumulative ack nodeID's uplink sent.
func (s *Server) NextUplinkAck(ctx context.Context, nodeID string) (uint64, error) {
	s.mu.Lock()
	u := s.nodes[nodeID]
	s.mu.Unlock()
	if u == nil {
		return 0, errors.New("relaytest: node offline")
	}
	select {
	case n := <-u.k.acks:
		return n, nil
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

// Online reports whether nodeID has an authenticated uplink.
func (s *Server) Online(nodeID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.nodes[nodeID] != nil
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/healthz" {
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(`{"ok":true,"version":"pen-relay/1.0"}`))
		return
	}
	role, nodeID, ok := strings.Cut(strings.TrimPrefix(r.URL.Path, "/v1/"), "/")
	if !ok || (role != "node" && role != "client") {
		http.NotFound(w, r)
		return
	}
	if !ident.ValidNodeID(nodeID) {
		http.Error(w, "bad nodeId", http.StatusBadRequest)
		return
	}
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		http.Error(w, "upgrade required", http.StatusUpgradeRequired)
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	ws.SetReadLimit(wire.MaxMessage)
	k := newSock(ws)
	if role == "node" {
		s.serveNode(k, "ws://"+strings.ToLower(r.Host), nodeID)
	} else {
		s.serveClient(k, nodeID)
	}
}

func (s *Server) serveNode(k *sock, origin, nodeID string) {
	ctx := context.Background()
	challenge := make([]byte, 32)
	rand.Read(challenge)
	// Like the relay, the challenge counts toward the bytes the node must ack.
	if err := k.send(ctx, challenge); err != nil {
		return
	}
	actx, acancel := context.WithTimeout(ctx, 10*time.Second)
	typ, ans, err := k.ws.Read(actx)
	acancel()
	if err != nil || typ != websocket.MessageBinary || len(ans) != 96 ||
		ident.NodeID(ans[:32]) != nodeID ||
		!ed25519.Verify(ans[:32], wire.ChallengeMessage(origin, nodeID, challenge), ans[32:]) {
		k.ws.Close(websocket.StatusCode(wire.CodeRelayAuth), "")
		return
	}
	uctx := ctx
	u := &uplink{k: k, clients: map[uint32]*sock{}}
	s.mu.Lock()
	old := s.nodes[nodeID]
	s.nodes[nodeID] = u
	if ch := s.online[nodeID]; ch != nil {
		close(ch)
		delete(s.online, nodeID)
	}
	s.mu.Unlock()
	if old != nil {
		old.k.closeAsync(wire.CodeReplaced)
	}
	defer func() {
		s.mu.Lock()
		if s.nodes[nodeID] == u {
			delete(s.nodes, nodeID)
		}
		clients := u.clients
		u.clients = map[uint32]*sock{}
		s.mu.Unlock()
		for _, c := range clients {
			c.closeAsync(wire.CodeOffline)
		}
	}()
	for {
		typ, p, err := k.ws.Read(uctx)
		if err != nil {
			return
		}
		if typ == websocket.MessageText {
			if !s.text(uctx, k, p) {
				return
			}
			continue
		}
		f, err := wire.DecodeFrame(p)
		if err != nil || f.Type == wire.FrameOpen {
			k.closeAsync(wire.CodeRelayProtocol)
			return
		}
		s.mu.Lock()
		c := u.clients[f.SID]
		if f.Type == wire.FrameClose {
			delete(u.clients, f.SID)
		}
		s.mu.Unlock()
		if c == nil {
			continue
		}
		if f.Type == wire.FrameData {
			c.send(uctx, f.Payload)
		} else {
			c.closeAsync(f.CloseCode())
		}
	}
}

func (s *Server) serveClient(k *sock, nodeID string) {
	s.mu.Lock()
	u := s.nodes[nodeID]
	var sid uint32
	if u != nil {
		u.nextSID++
		sid = u.nextSID
		u.clients[sid] = k
	}
	s.mu.Unlock()
	if u == nil {
		k.ws.Close(websocket.StatusCode(wire.CodeOffline), "")
		return
	}
	ctx := context.Background()
	if err := u.k.send(ctx, wire.Frame{Type: wire.FrameOpen, SID: sid}.Encode()); err != nil {
		k.closeAsync(wire.CodeOffline)
		return
	}
	for {
		typ, p, err := k.ws.Read(ctx)
		if err != nil {
			s.mu.Lock()
			_, live := u.clients[sid]
			delete(u.clients, sid)
			s.mu.Unlock()
			if live {
				code := websocket.CloseStatus(err)
				if code < 1000 || code > 4999 {
					code = 1000
				}
				u.k.send(ctx, wire.CloseFrame(sid, uint16(code)).Encode())
			}
			return
		}
		if typ == websocket.MessageText {
			if !s.text(ctx, k, p) {
				return
			}
			continue
		}
		u.k.send(ctx, wire.Frame{Type: wire.FrameData, SID: sid, Payload: p}.Encode())
	}
}
