// Package relay connects to a Pen relay: the node uplink and client sockets, both as message links.
package relay

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// Conn is a message link: one Send is one message at the peer.
type Conn interface {
	Send(p []byte) error
	Recv(ctx context.Context) ([]byte, error)
	Close(code uint16) error
}

// CloseError is a session closed with a code (by the peer or the relay).
type CloseError struct{ Code uint16 }

func (e *CloseError) Error() string { return fmt.Sprintf("closed %d", e.Code) }

// CodeOf returns err's close code, or 0.
func CodeOf(err error) uint16 {
	var ce *CloseError
	if errors.As(err, &ce) {
		return ce.Code
	}
	return 0
}

// ErrClosed is returned after this side closed the link.
var ErrClosed = errors.New("relay: link closed")

// MaxQueued caps bytes received but not yet consumed on one session; past it the session closes 4408.
const MaxQueued = 16 << 20

// inbox is an ordered queue of messages ending in one terminal error. It never blocks the producer.
type inbox struct {
	mu     sync.Mutex
	msgs   [][]byte
	bytes  int
	err    error
	notify chan struct{}
}

func newInbox() *inbox { return &inbox{notify: make(chan struct{}, 1)} }

func (q *inbox) wake() {
	select {
	case q.notify <- struct{}{}:
	default:
	}
}

// push queues p; false when the queue would exceed MaxQueued.
func (q *inbox) push(p []byte) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.err != nil {
		return true
	}
	if q.bytes+len(p) > MaxQueued {
		return false
	}
	q.msgs = append(q.msgs, p)
	q.bytes += len(p)
	q.wake()
	return true
}

// fail ends the queue after the messages already in it; the first error wins.
func (q *inbox) fail(err error) {
	q.mu.Lock()
	if q.err == nil {
		q.err = err
	}
	q.mu.Unlock()
	q.wake()
}

// drop ends the queue at once, discarding unread messages.
func (q *inbox) drop(err error) {
	q.mu.Lock()
	q.msgs, q.bytes = nil, 0
	if q.err == nil {
		q.err = err
	}
	q.mu.Unlock()
	q.wake()
}

func (q *inbox) recv(ctx context.Context) ([]byte, error) {
	for {
		q.mu.Lock()
		if len(q.msgs) > 0 {
			p := q.msgs[0]
			q.msgs[0] = nil
			q.msgs = q.msgs[1:]
			q.bytes -= len(p)
			if len(q.msgs) > 0 || q.err != nil {
				q.wake()
			}
			q.mu.Unlock()
			return p, nil
		}
		if q.err != nil {
			err := q.err
			q.mu.Unlock()
			q.wake()
			return nil, err
		}
		q.mu.Unlock()
		select {
		case <-q.notify:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// Pipe returns two connected in-memory links.
func Pipe() (Conn, Conn) {
	a := &pipeEnd{in: newInbox()}
	b := &pipeEnd{in: newInbox()}
	a.peer, b.peer = b, a
	return a, b
}

type pipeEnd struct {
	in     *inbox
	peer   *pipeEnd
	mu     sync.Mutex
	closed bool
}

func (p *pipeEnd) Send(m []byte) error {
	p.mu.Lock()
	closed := p.closed
	p.mu.Unlock()
	if closed {
		return ErrClosed
	}
	if !p.peer.in.push(append([]byte(nil), m...)) {
		p.Close(wire.CodeTimeout)
		return &CloseError{Code: wire.CodeTimeout}
	}
	return nil
}

func (p *pipeEnd) Recv(ctx context.Context) ([]byte, error) { return p.in.recv(ctx) }

func (p *pipeEnd) Close(code uint16) error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil
	}
	p.closed = true
	p.mu.Unlock()
	p.in.drop(ErrClosed)
	p.peer.in.fail(&CloseError{Code: code})
	return nil
}

