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
	// ClientMessages counts binary messages client sockets sent through this relay.
	ClientMessages atomic.Int64
	// ForwardDelay holds each binary client message this long before the relay forwards it to the
	// node; PongDelay does the same for client text (ping), so the relay answers pong late.
	ForwardDelay, PongDelay atomic.Int64

	mu      sync.Mutex
	online  map[string]chan struct{}
	acks    map[string]chan uint64
	uplinks map[string]chan struct{}
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
		uplinks: map[string]chan struct{}{}}
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
		OnClientMessage: func(_ string, text bool) {
			delay := &s.ForwardDelay
			if text {
				delay = &s.PongDelay
			} else {
				s.ClientMessages.Add(1)
			}
			if d := time.Duration(delay.Load()); d > 0 {
				time.Sleep(d)
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

// Close stops the relay and aborts its sockets.
func (s *Server) Close() {
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

func (s *Server) uplinkChan(nodeID string) chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := s.uplinks[nodeID]
	if ch == nil {
		ch = make(chan struct{}, 64)
		s.uplinks[nodeID] = ch
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
