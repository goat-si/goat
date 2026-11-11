package relayserver

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// stalledWS blocks every write until release closes or, as a real socket does, until it is
// closed; it records aborts.
type stalledWS struct {
	release chan struct{}
	mu      sync.Mutex
	aborted bool
	gone    chan struct{}
}

func (w *stalledWS) closed() chan struct{} {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.gone == nil {
		w.gone = make(chan struct{})
	}
	return w.gone
}

func (w *stalledWS) Write(ctx context.Context, _ websocket.MessageType, _ []byte) error {
	select {
	case <-w.release:
		return nil
	case <-w.closed():
		return errors.New("closed")
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (w *stalledWS) Close(websocket.StatusCode, string) error { return nil }
func (w *stalledWS) CloseNow() error {
	gone := w.closed()
	w.mu.Lock()
	if !w.aborted {
		w.aborted = true
		close(gone)
	}
	w.mu.Unlock()
	return nil
}

func TestTinyQueuedItemsCountTowardTheQueueLimitSoMemoryStaysBounded(t *testing.T) {
	ws := &stalledWS{release: make(chan struct{})}
	defer close(ws.release)
	q := newOutq(ws, time.Hour, nil)
	limit := SocketWindow + RelayHeadroom + queueSlack
	for range limit / 32 {
		q.binary([]byte{0})
	}
	ws.mu.Lock()
	aborted := ws.aborted
	ws.mu.Unlock()
	q.mu.Lock()
	held := q.n
	q.mu.Unlock()
	if !aborted || held > limit/32 {
		t.Fatalf("%d one-byte items queued without an abort", held)
	}
}

func TestQueuedPongsAreCapped(t *testing.T) {
	ws := &stalledWS{release: make(chan struct{})}
	defer close(ws.release)
	q := newOutq(ws, time.Hour, nil)
	q.binary([]byte{1}) // the writer stalls on this one
	for range 100 {
		q.text("pong")
	}
	// Count pongs only: the stalled binary item may or may not have left the queue yet.
	q.mu.Lock()
	held := 0
	for _, it := range q.ring {
		if it.is(itemPong) {
			held++
		}
	}
	q.mu.Unlock()
	if held > maxQueuedPongs {
		t.Fatalf("%d pongs queued behind a stalled write, want at most %d", held, maxQueuedPongs)
	}
}

// fastWS takes every write and close at once.
type fastWS struct{}

func (fastWS) Write(context.Context, websocket.MessageType, []byte) error { return nil }
func (fastWS) Close(websocket.StatusCode, string) error                   { return nil }
func (fastWS) CloseNow() error                                            { return nil }

// A closed socket's close timer holds its queue and connection: it must be stopped once the writer
// has ended, or every closed socket stays in memory for the write timeout (session churn kept
// gigabytes that way).
func TestAClosedQueueStopsItsCloseTimerWhenTheWriterEnds(t *testing.T) {
	q := newOutq(fastWS{}, time.Hour, nil)
	q.close(1000)
	q.mu.Lock()
	timer := q.closeTimer
	q.mu.Unlock()
	q.wait()
	if timer != nil && timer.Stop() {
		t.Fatal("the close timer of an ended queue was still pending")
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closeTimer != nil {
		t.Fatal("an ended queue still holds its close timer")
	}
}
