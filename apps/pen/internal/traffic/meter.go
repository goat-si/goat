package traffic

import (
	"context"
	"sync"

	"github.com/goat-si/goat/apps/pen/internal/stream"
)

// settleWaiting, when set, runs as Settle starts waiting for calls in flight (tests).
var settleWaiting func()

// Metered is a Link that calls add with the DATA payload of every record it sends (out) and receives (in). Framing,
// CREDIT and FIN records and the bytes of the layers below are not counted. add runs on the sending and the
// receiving goroutine, so it must be safe for concurrent use.
type Metered struct {
	stream.Link
	add func(in, out uint64)

	mu       sync.Mutex
	inflight int
	idle     []chan struct{}
}

// Meter wraps l.
func Meter(l stream.Link, add func(in, out uint64)) *Metered { return &Metered{Link: l, add: add} }

func (m *Metered) enter() {
	m.mu.Lock()
	m.inflight++
	m.mu.Unlock()
}

func (m *Metered) leave() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.inflight--; m.inflight == 0 {
		for _, ch := range m.idle {
			close(ch)
		}
		m.idle = nil
	}
}

func (m *Metered) Send(p []byte) error {
	m.enter()
	defer m.leave()
	err := m.Link.Send(p)
	if err == nil && len(p) > 1 && p[0] == stream.TypeData {
		m.add(0, uint64(len(p)-1))
	}
	return err
}

func (m *Metered) Recv(ctx context.Context) ([]byte, error) {
	m.enter()
	defer m.leave()
	p, err := m.Link.Recv(ctx)
	if err == nil && len(p) > 1 && p[0] == stream.TypeData {
		m.add(uint64(len(p)-1), 0)
	}
	return p, err
}

// Settle waits, until ctx ends, until no Send or Recv is in progress. stream.Splice returns on an error without waiting
// for its workers, so a send that completed just before the end is counted only once its call returns.
func (m *Metered) Settle(ctx context.Context) {
	m.mu.Lock()
	if m.inflight == 0 {
		m.mu.Unlock()
		return
	}
	ch := make(chan struct{})
	m.idle = append(m.idle, ch)
	m.mu.Unlock()
	if settleWaiting != nil {
		settleWaiting()
	}
	select {
	case <-ch:
	case <-ctx.Done():
	}
}
