// Package relaytest runs the Go relay (internal/relayserver) in process for hermetic tests and adds
// waits on its events.
package relaytest

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/relayserver"
)

// Server is a relay under test.
type Server struct {
	URL   string
	Relay *relayserver.Server
	http  *httptest.Server

	// BadAcks counts sockets closed 4402 for an ack that decreased or exceeded what was sent.
	BadAcks atomic.Int64
	// ForwardDelay holds each binary client message this long before the relay forwards it to the
	// node; PongDelay does the same for client text (ping), so the relay answers pong late. Set
	// them before the relay serves (the relaytest command's flags); tests use HoldForwarding and
	// HoldPongs instead.
	ForwardDelay, PongDelay time.Duration
	// nodeHold is the gate the next binary message an uplink sends waits for (HoldNextUplinkMessage).
	nodeHold atomic.Pointer[chan struct{}]

	forward, pongs gate

	mu          sync.Mutex
	online      map[string]chan struct{}
	acks        map[string]chan uint64
	uplinks     map[string]chan struct{}
	uplinkPings map[string]chan struct{}
	clientMsgs  map[string]chan struct{}
}

// gate blocks callers of wait while it is held.
type gate struct {
	mu sync.Mutex
	ch chan struct{}
}

func (g *gate) hold() func() {
	g.mu.Lock()
	if g.ch == nil {
		g.ch = make(chan struct{})
	}
	g.mu.Unlock()
	return g.release
}

func (g *gate) release() {
	g.mu.Lock()
	if g.ch != nil {
		close(g.ch)
		g.ch = nil
	}
	g.mu.Unlock()
}

func (g *gate) wait() {
	g.mu.Lock()
	ch := g.ch
	g.mu.Unlock()
	if ch != nil {
		<-ch
	}
}

// HoldForwarding keeps the relay from forwarding any client message to the node until release
// runs (or the relay closes); the client's socket stays open and pings still get pongs.
func (s *Server) HoldForwarding() (release func()) { return s.forward.hold() }

// HoldPongs keeps the relay from answering client pings until release runs (or the relay closes);
// client messages are still forwarded.
func (s *Server) HoldPongs() (release func()) { return s.pongs.hold() }

// HoldNextUplinkMessage keeps the relay from handling the next binary message any uplink sends (an
// authentication answer, typically) until release runs, as a busy relay would; that uplink's
// later messages wait behind it.
func (s *Server) HoldNextUplinkMessage() (release func()) {
	ch := make(chan struct{})
	s.nodeHold.Store(&ch)
	var once sync.Once
	return func() { once.Do(func() { close(ch) }) }
}

// NextClientMessage waits until a client of nodeID sends a message the relay takes.
func (s *Server) NextClientMessage(ctx context.Context, nodeID string) error {
	select {
	case <-s.chanOf(s.clientMsgs, nodeID):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// DrainClientMessages forgets the client messages to nodeID that no NextClientMessage has returned for yet.
func (s *Server) DrainClientMessages(nodeID string) {
	ch := s.chanOf(s.clientMsgs, nodeID)
	for {
		select {
		case <-ch:
		default:
			return
		}
	}
}

// New starts a relay with the contract limits on 127.0.0.1.
func New() *Server {
	s := NewUnstarted()
	s.http = httptest.NewServer(s.Relay)
	s.URL = s.http.URL
	return s
}

// NewUnstarted builds a relay for use as an http.Handler.
func NewUnstarted() *Server { return NewWithLimits(relayserver.DefaultLimits()) }

// NewWithLimits builds an unstarted relay with custom timeouts.
func NewWithLimits(l relayserver.Limits) *Server {
	s := &Server{Relay: relayserver.New(l), online: map[string]chan struct{}{}, acks: map[string]chan uint64{},
		uplinks: map[string]chan struct{}{}, uplinkPings: map[string]chan struct{}{}, clientMsgs: map[string]chan struct{}{}}
	s.Relay.Hooks = relayserver.Hooks{
		OnUplink: func(nodeID string) {
			s.mu.Lock()
			if ch := s.online[nodeID]; ch != nil {
				close(ch)
				delete(s.online, nodeID)
			}
			s.mu.Unlock()
			select {
			case s.uplinkChan(nodeID) <- struct{}{}:
			default:
			}
		},
		OnAck: func(nodeID string, n uint64) {
			select {
			case s.ackChan(nodeID) <- n:
			default:
			}
		},
		OnBadAck: func() { s.BadAcks.Add(1) },
		OnMessage: func(nodeID, role string, text bool) {
			if role == "client" {
				select {
				case s.chanOf(s.clientMsgs, nodeID) <- struct{}{}:
				default:
				}
			}
			switch {
			case role == "node" && !text:
				if g := s.nodeHold.Swap(nil); g != nil {
					<-*g
				}
			case role == "node" && text:
				select {
				case s.chanOf(s.uplinkPings, nodeID) <- struct{}{}:
				default:
				}
			case role == "client" && text:
				s.pongs.wait()
				time.Sleep(s.PongDelay)
			case role == "client":
				s.forward.wait()
				time.Sleep(s.ForwardDelay)
			}
		},
	}
	return s
}

// Start serves an unstarted relay on 127.0.0.1.
func (s *Server) Start() {
	s.http = httptest.NewServer(s.Relay)
	s.URL = s.http.URL
}

// Handler serves the relay routes.
func (s *Server) Handler() http.Handler { return s.Relay }

// Close releases any hold, stops the relay and aborts its sockets.
func (s *Server) Close() {
	s.forward.release()
	s.pongs.release()
	s.Relay.Close()
	if s.http != nil {
		s.http.CloseClientConnections()
		s.http.Close()
	}
}

// DropUplink aborts nodeID's uplink as a failing network would.
func (s *Server) DropUplink(nodeID string) bool { return s.Relay.DropUplink(nodeID) }

// Online reports whether nodeID has an authenticated uplink.
func (s *Server) Online(nodeID string) bool { return s.Relay.Online(nodeID) }

// WaitOnline returns once nodeID has an authenticated uplink.
func (s *Server) WaitOnline(ctx context.Context, nodeID string) error {
	s.mu.Lock()
	ch := s.online[nodeID]
	if ch == nil {
		ch = make(chan struct{})
		s.online[nodeID] = ch
	}
	s.mu.Unlock()
	// Checked after the channel exists: an authentication before this point shows here, one after
	// it closes the channel.
	if s.Relay.Online(nodeID) {
		return nil
	}
	select {
	case <-ch:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Server) ackChan(nodeID string) chan uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := s.acks[nodeID]
	if ch == nil {
		ch = make(chan uint64, 64)
		s.acks[nodeID] = ch
	}
	return ch
}

// NextUplinkAck returns the next cumulative ack an uplink of nodeID sent.
func (s *Server) NextUplinkAck(ctx context.Context, nodeID string) (uint64, error) {
	select {
	case n := <-s.ackChan(nodeID):
		return n, nil
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

func (s *Server) uplinkChan(nodeID string) chan struct{} { return s.chanOf(s.uplinks, nodeID) }

// chanOf returns m's event channel for nodeID, making it on first use.
func (s *Server) chanOf(m map[string]chan struct{}, nodeID string) chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := m[nodeID]
	if ch == nil {
		ch = make(chan struct{}, 64)
		m[nodeID] = ch
	}
	return ch
}

// NextUplink returns once an uplink of nodeID authenticated that no earlier call returned for,
// counting from the relay's start.
func (s *Server) NextUplink(ctx context.Context, nodeID string) error {
	select {
	case <-s.uplinkChan(nodeID):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// NextUplinkPing returns once an uplink of nodeID sent a text message (a ping, or an ack after
// 64 KiB of traffic) that no earlier call returned for.
func (s *Server) NextUplinkPing(ctx context.Context, nodeID string) error {
	select {
	case <-s.chanOf(s.uplinkPings, nodeID):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
