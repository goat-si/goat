package relay

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"math/rand/v2"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// ErrReplaced is returned by Uplink.Run when a newer uplink for this nodeId took over (4409).
var ErrReplaced = errors.New("relay: uplink replaced by a newer one (4409)")

// errSilent ends an uplink that received nothing for two ping intervals: the path died without a
// close (sleep, a dropped NAT mapping), and writes alone would not notice for minutes.
var errSilent = errors.New("relay sent nothing for two ping intervals")

// AuthTimeout bounds the wait for the relay's challenge.
const AuthTimeout = 10 * time.Second

// Uplink is the node's authenticated socket at /v1/node/<nodeId>; it demuxes relay sessions.
type Uplink struct {
	RelayURL string
	ID       *ident.Identity
	// OnState is called with true after each authentication and false when the socket drops.
	OnState func(up bool)
	Logf    func(format string, args ...any)

	// MinBackoff and MaxBackoff bound the reconnect delay (0.5 s doubling to 30 s by default).
	MinBackoff, MaxBackoff time.Duration
	// PingInterval is the keepalive period (relay.PingInterval when zero).
	PingInterval time.Duration

	accept chan Conn
	// kick asks Run to reconnect at once (Redial); drop ends the current socket.
	kick chan struct{}
	mu   sync.Mutex
	drop context.CancelFunc
}

// NewUplinkInto builds an uplink whose sessions arrive on accept (shared by several uplinks).
func NewUplinkInto(relayURL string, id *ident.Identity, accept chan Conn) *Uplink {
	u := NewUplink(relayURL, id)
	u.accept = accept
	return u
}

// NewUplink builds an uplink for id at relayURL.
func NewUplink(relayURL string, id *ident.Identity) *Uplink {
	return &Uplink{RelayURL: relayURL, ID: id, accept: make(chan Conn, 64), kick: make(chan struct{}, 1),
		MinBackoff: 500 * time.Millisecond, MaxBackoff: 30 * time.Second}
}

// Redial drops the current socket, if any, and reconnects at once without backoff (after the
// machine woke, the old socket is likely dead and a write would take minutes to notice).
func (u *Uplink) Redial() {
	select {
	case u.kick <- struct{}{}:
	default:
	}
	u.mu.Lock()
	drop := u.drop
	u.mu.Unlock()
	if drop != nil {
		drop()
	}
}

// Accept returns the next relay session (an OPEN).
func (u *Uplink) Accept(ctx context.Context) (Conn, error) {
	select {
	case c := <-u.accept:
		return c, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (u *Uplink) logf(format string, args ...any) {
	if u.Logf != nil {
		u.Logf(format, args...)
	}
}

// Run keeps the uplink connected until ctx ends or the relay replaces it (ErrReplaced).
func (u *Uplink) Run(ctx context.Context) error {
	backoff := u.MinBackoff
	for {
		start := time.Now()
		err := u.runOnce(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if errors.Is(err, ErrReplaced) {
			return err
		}
		select {
		case <-u.kick:
			u.logf("uplink: redialing at once")
			backoff = u.MinBackoff
			continue
		default:
		}
		if time.Since(start) > 10*time.Second {
			backoff = u.MinBackoff
		}
		delay := backoff/2 + time.Duration(rand.Int64N(int64(backoff/2)+1))
		u.logf("uplink: %v; reconnecting in %v", err, delay.Round(time.Millisecond))
		t := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			t.Stop()
			return ctx.Err()
		case <-u.kick:
			t.Stop()
			backoff = u.MinBackoff
			continue
		case <-t.C:
		}
		backoff = min(backoff*2, u.MaxBackoff)
	}
}

// AnswerChallenge builds signPub || sig for the uplink challenge.
func AnswerChallenge(id *ident.Identity, relayOrigin string, challenge []byte) []byte {
	sig := ed25519.Sign(id.SignPriv, wire.ChallengeMessage(relayOrigin, id.NodeID(), challenge))
	return append(append([]byte(nil), id.SignPub...), sig...)
}

func (u *Uplink) runOnce(ctx context.Context) error {
	nodeID := u.ID.NodeID()
	wsURL, err := wire.WebSocketURL(u.RelayURL, "/v1/node/"+nodeID)
	if err != nil {
		return err
	}
	origin, err := wire.RelayOrigin(u.RelayURL)
	if err != nil {
		return err
	}
	dctx, dcancel := context.WithTimeout(ctx, AuthTimeout)
	ws, err := dialWS(dctx, wsURL)
	if err != nil {
		dcancel()
		return err
	}
	typ, challenge, err := ws.Read(dctx)
	dcancel()
	if err != nil {
		ws.CloseNow()
		return fmt.Errorf("challenge: %w", err)
	}
	if typ != websocket.MessageBinary || len(challenge) != 32 {
		ws.Close(websocket.StatusCode(wire.CodeRelayProtocol), "")
		return errors.New("challenge: not 32 binary bytes")
	}
	lctx, cancel := context.WithCancel(ctx)
	defer cancel()
	u.mu.Lock()
	u.drop = cancel
	u.mu.Unlock()
	defer func() {
		u.mu.Lock()
		u.drop = nil
		u.mu.Unlock()
	}()
	if err := ws.Write(lctx, websocket.MessageBinary, AnswerChallenge(u.ID, origin, challenge)); err != nil {
		ws.CloseNow()
		return err
	}
	// Any message counts as life: the relay may hold a pong behind a slow write.
	every := u.pingInterval()
	var silent atomic.Bool
	deadline := time.AfterFunc(2*every, func() {
		silent.Store(true)
		cancel()
	})
	defer deadline.Stop()
	m := &mux{ws: ws, ctx: lctx, sessions: map[uint32]*muxConn{}, heard: func() { deadline.Reset(2 * every) }}
	if u.OnState != nil {
		u.OnState(true)
		defer u.OnState(false)
	}
	go pinger(lctx, ws, every)
	err = m.readLoop(u.accept, len(challenge))
	if silent.Load() && ctx.Err() == nil {
		ws.CloseNow()
		err = errSilent
	}
	code := statusCode(err)
	m.failAll(&CloseError{Code: wire.CodeOffline})
	if code == wire.CodeReplaced {
		return ErrReplaced
	}
	if ctx.Err() != nil {
		ws.Close(websocket.StatusNormalClosure, "")
	}
	return err
}

func (u *Uplink) pingInterval() time.Duration {
	if u.PingInterval > 0 {
		return u.PingInterval
	}
	return PingInterval
}

type mux struct {
	ws  *websocket.Conn
	ctx context.Context
	// heard is called with every message the relay sends.
	heard func()

	mu       sync.Mutex
	sessions map[uint32]*muxConn
	dead     bool
}

func (m *mux) protocolError(err error) error {
	m.ws.Close(websocket.StatusCode(wire.CodeRelayProtocol), "")
	return err
}

// readLoop demuxes relay frames. received is what already arrived (the challenge): acks count every
// binary message the relay sent on this socket.
func (m *mux) readLoop(accept chan Conn, received int) error {
	ack := acker{total: uint64(received)}
	for {
		typ, p, err := m.ws.Read(m.ctx)
		if err != nil {
			return err
		}
		m.heard()
		if typ != websocket.MessageBinary {
			continue
		}
		if s, ok := ack.add(len(p)); ok {
			if err := m.ws.Write(m.ctx, websocket.MessageText, []byte(s)); err != nil {
				return err
			}
		}
		f, err := wire.DecodeFrame(p)
		if err != nil {
			return m.protocolError(err)
		}
		switch f.Type {
		case wire.FrameOpen:
			c := &muxConn{m: m, sid: f.SID, in: newInbox()}
			m.mu.Lock()
			_, dup := m.sessions[f.SID]
			if !dup {
				m.sessions[f.SID] = c
			}
			m.mu.Unlock()
			if dup {
				return m.protocolError(fmt.Errorf("OPEN for live sid %d", f.SID))
			}
			select {
			case accept <- c:
			default:
				c.Close(wire.CodeCaps)
			}
		case wire.FrameData:
			m.mu.Lock()
			c := m.sessions[f.SID]
			m.mu.Unlock()
			if c != nil && !c.in.push(f.Payload) {
				c.in.drop(&CloseError{Code: wire.CodeTimeout})
				c.Close(wire.CodeTimeout)
			}
		case wire.FrameClose:
			m.mu.Lock()
			c := m.sessions[f.SID]
			delete(m.sessions, f.SID)
			m.mu.Unlock()
			if c != nil {
				c.remoteClosed(f.CloseCode())
			}
		}
	}
}

func (m *mux) failAll(err error) {
	m.mu.Lock()
	m.dead = true
	all := m.sessions
	m.sessions = map[uint32]*muxConn{}
	m.mu.Unlock()
	for _, c := range all {
		c.remoteClosed(CodeOf(err))
	}
}

func (m *mux) write(f wire.Frame) error {
	if err := m.ws.Write(m.ctx, websocket.MessageBinary, f.Encode()); err != nil {
		return &CloseError{Code: wire.CodeOffline}
	}
	return nil
}

type muxConn struct {
	m   *mux
	sid uint32
	in  *inbox

	mu     sync.Mutex
	closed bool
}

func (c *muxConn) remoteClosed(code uint16) {
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	c.in.fail(&CloseError{Code: code})
}

func (c *muxConn) Send(p []byte) error {
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if closed {
		return ErrClosed
	}
	return c.m.write(wire.Frame{Type: wire.FrameData, SID: c.sid, Payload: p})
}

func (c *muxConn) Recv(ctx context.Context) ([]byte, error) { return c.in.recv(ctx) }

func (c *muxConn) SetQueueLimit(n int) { c.in.setLimit(n) }

func (c *muxConn) Close(code uint16) error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	c.mu.Unlock()
	c.m.mu.Lock()
	delete(c.m.sessions, c.sid)
	c.m.mu.Unlock()
	c.in.drop(ErrClosed)
	return c.m.write(wire.CloseFrame(c.sid, code))
}
