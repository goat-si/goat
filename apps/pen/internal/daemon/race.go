package daemon

import (
	"context"
	"errors"
	"sync"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/session"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

var errLostRace = errors.New("another relay answered first")

// OpenSession reaches nodeID for a kind 0x01 session by running the handshake on every relay at
// once and keeping the first whose message 2 verifies: that relay's path reached the node and
// back fastest, which a pong from the relay alone does not show. Only the winner is confirmed;
// every other link closes 1000 unconfirmed, so its responder never opens the stream. A 4401 or
// 4400 close on any relay is the node's answer and ends the race; a message 2 that fails to
// verify here (session.ErrBadMessage2) may be a relay's forgery, so the race goes on.
func OpenSession(ctx context.Context, relays []string, nodeID string, start func(context.Context, relay.Conn) (*session.Pending, error)) (*session.Secure, error) {
	sec, _, err := openSessionVia(ctx, relays, nodeID, start)
	return sec, err
}

// openSessionVia is OpenSession that also names the relay that won the race.
func openSessionVia(ctx context.Context, relays []string, nodeID string, start func(context.Context, relay.Conn) (*session.Pending, error)) (*session.Secure, string, error) {
	if len(relays) == 0 {
		return nil, "", errors.New("relay: no relays")
	}
	emit := relay.Tracer(relay.TraceOf(ctx))
	// Losers finish their dial (an aborted WebSocket handshake would reach the node as 1006)
	// within the race's bound, then close 1000.
	dctx, dcancel := context.WithTimeout(ctx, relay.DialRaceTimeout)
	type result struct {
		url     string
		pending *session.Pending
		err     error
		// handshake marks an error from a socket that connected.
		handshake bool
		// refusal marks the node's own answer (a 4401 or 4400 close), which ended the race.
		refusal bool
	}
	results := make(chan result, len(relays))
	var mu sync.Mutex
	decided := false
	conns := map[string]relay.Conn{}
	// decideLocked ends the race for every link but keep's (none for ""); it reports false when
	// the race already ended. The caller holds mu, so one winner or one refusal ends it, never both.
	decideLocked := func(keep string) bool {
		if decided {
			return false
		}
		decided = true
		for u, c := range conns {
			if u != keep {
				go func() {
					c.Close(wire.CodeNormal)
					emit("loser closed", u)
				}()
			}
		}
		return true
	}
	for _, u := range relays {
		go func() {
			c, err := relay.Dial(dctx, u, nodeID)
			if err != nil {
				emit(relay.DialEvent(dctx), u)
				results <- result{url: u, err: err}
				return
			}
			emit("ws", u)
			mu.Lock()
			lost := decided
			if !lost {
				conns[u] = c
			}
			mu.Unlock()
			if lost {
				c.Close(wire.CodeNormal)
				emit("loser closed", u)
				results <- result{url: u, err: errLostRace}
				return
			}
			p, err := start(ctx, c)
			if err != nil {
				refusal := nodeRefused(err)
				mu.Lock()
				delete(conns, u)
				lost := decided
				if refusal && !lost {
					decideLocked("")
				}
				mu.Unlock()
				if lost {
					results <- result{url: u, err: errLostRace}
					return
				}
				if errors.Is(err, session.ErrBadMessage2) {
					emit("bad answer", u)
				} else {
					emit(relay.ClosedEvent(err), u)
				}
				c.Close(wire.CodeNormal)
				results <- result{url: u, err: err, handshake: true, refusal: refusal}
				return
			}
			emit("answer", u)
			mu.Lock()
			won := decideLocked(u)
			mu.Unlock()
			if !won {
				p.Abort(wire.CodeNormal)
				emit("loser closed", u)
				results <- result{url: u, err: errLostRace}
				return
			}
			results <- result{url: u, pending: p}
		}()
	}
	drain := func(left int) {
		for range left {
			if r := <-results; r.pending != nil {
				r.pending.Abort(wire.CodeNormal)
			}
		}
		dcancel()
	}
	var handshakeErr, offline, last error
	for i := range relays {
		r := <-results
		if r.pending != nil {
			go drain(len(relays) - i - 1)
			emit("winner", r.url)
			sec, err := r.pending.Confirm()
			if err != nil {
				r.pending.Abort(wire.CodeNormal)
				return nil, "", err
			}
			emit("confirmed", r.url)
			return sec, r.url, nil
		}
		if r.refusal {
			go drain(len(relays) - i - 1)
			return nil, "", r.err
		}
		code := relay.CodeOf(r.err)
		switch {
		case code == wire.CodeOffline:
			offline = r.err
		case r.handshake && handshakeErr == nil:
			handshakeErr = r.err
		}
		last = r.err
	}
	dcancel()
	for _, err := range []error{handshakeErr, offline, last} {
		if err != nil {
			return nil, "", err
		}
	}
	return nil, "", last
}

// nodeRefused reports a close only the node sends: 4401, or 4400 from the far side. A message 2
// that failed to verify here also carries 4400 but may be a relay's forgery.
func nodeRefused(err error) bool {
	code := relay.CodeOf(err)
	return (code == wire.CodeNotAdmitted || code == wire.CodeCrypto) && !errors.Is(err, session.ErrBadMessage2)
}

// openMember opens a kind 0x01 session with payload to the member nodeID whose Noise key is noise.
func openMember(ctx context.Context, relays []string, id *ident.Identity, nodeID string, noise []byte, payload session.Payload) (*session.Secure, error) {
	return OpenSession(ctx, relays, nodeID, func(ctx context.Context, conn relay.Conn) (*session.Pending, error) {
		return session.InitiateHandshake(ctx, conn, session.KindSession, nodeID, noise, id, nil, payload)
	})
}

// openMemberVia is openMember that also names the relay the session runs on.
func openMemberVia(ctx context.Context, relays []string, id *ident.Identity, nodeID string, noise []byte, payload session.Payload) (*session.Secure, string, error) {
	return openSessionVia(ctx, relays, nodeID, func(ctx context.Context, conn relay.Conn) (*session.Pending, error) {
		return session.InitiateHandshake(ctx, conn, session.KindSession, nodeID, noise, id, nil, payload)
	})
}
