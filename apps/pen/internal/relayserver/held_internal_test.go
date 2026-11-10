package relayserver

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"
	"time"
	"unsafe"

	"github.com/coder/websocket"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// A frame the relay read stays in memory for as long as its payload waits in a client's queue. A
// payload sliced from its read buffer would keep that whole buffer alive, so a queued payload must
// be its own copy no larger than its allocation, and the server-wide count must cover every queued
// payload's capacity and the ring that holds them.
func TestTheQueueCountCoversTheMemoryQueuedFramesHold(t *testing.T) {
	s := New(DefaultLimits())
	ws := &stalledWS{release: make(chan struct{})}
	defer close(ws.release)
	rm := &room{srv: s, clients: map[uint32]*sock{}}
	up := testSock(s, rm, roleNode, 0, "192.0.2.1", ws)
	c := testSock(s, rm, roleClient, 1, "192.0.2.2", ws)
	frame := wire.Frame{Type: wire.FrameData, SID: 1, Payload: []byte{}}.Encode()
	for range 10_000 {
		// What the uplink's reader hands the room for each message.
		data, err := io.ReadAll(io.LimitReader(bytes.NewReader(frame), MessageMax+1))
		if err != nil {
			t.Fatal(err)
		}
		rm.mu.Lock()
		rm.onUplinkFrame(up, data)
		rm.mu.Unlock()
	}
	if c.closed {
		t.Fatal("the session ended; the test needs it to keep queueing")
	}
	q := c.out
	q.mu.Lock()
	held := len(q.ring)*int(unsafe.Sizeof(outItem{})) + q.writing
	for _, it := range q.ring {
		if cap(it.data) > allocSize(len(it.data)) && len(it.data) > 0 || len(it.data) == 0 && cap(it.data) > 0 {
			q.mu.Unlock()
			t.Fatalf("a queued %d-byte payload keeps %d bytes alive", len(it.data), cap(it.data))
		}
		held += cap(it.data)
	}
	q.mu.Unlock()
	if q := s.Queued(); q < int64(held) {
		t.Fatalf("the relay counts %d queued bytes while the queue holds %d", q, held)
	}
}

// countingWS lets n writes through, reporting each one, then blocks.
type countingWS struct {
	stalledWS
	wrote chan struct{}
}

func (w *countingWS) Write(ctx context.Context, typ websocket.MessageType, p []byte) error {
	select {
	case w.wrote <- struct{}{}:
		return nil
	case <-w.release:
		return nil
	case <-w.closed():
		return errors.New("closed")
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Once the writer has sent an item, nothing in the queue may keep its payload alive: the count
// dropped when it left, so memory that stays behind would be uncounted. Every ring slot must be
// empty once the queue is.
func TestADrainedQueueKeepsNoSentPayloadAlive(t *testing.T) {
	ws := &countingWS{stalledWS: stalledWS{release: make(chan struct{})}, wrote: make(chan struct{})}
	defer close(ws.release)
	q := newOutq(ws, time.Hour, testBudget(New(DefaultLimits()), "192.0.2.1"), false)
	const items = 64
	for range items {
		q.binary(make([]byte, 32<<10))
	}
	for range items {
		<-ws.wrote
	}
	// The writer takes the next item only after it has dropped the one it sent, so after one more
	// queued item has been written every earlier one has left the queue.
	q.binary([]byte{1})
	<-ws.wrote
	q.mu.Lock()
	defer q.mu.Unlock()
	for i, it := range q.ring {
		if it.data != nil {
			t.Fatalf("ring slot %d of an emptied queue still holds a %d-byte payload", i, cap(it.data))
		}
	}
}

// A message the relay is still reading holds memory as well: past the socket's read allowance it
// counts toward the large-read pool while it grows, and one that would pass it stops being read.
func TestAPartlyReadMessageCountsTowardTheBudgetUntilItWouldPassIt(t *testing.T) {
	s := New(DefaultLimits())
	s.MaxReading = 8 << 20 // one source may hold 1 MiB of it
	b := testBudget(s, "192.0.2.1")
	pr, pw := io.Pipe()
	defer pr.Close()
	type result struct {
		data []byte
		err  error
	}
	done := make(chan result, 1)
	go func() {
		data, err := readMessage(pr, MessageMax, b)
		done <- result{data, err}
	}()
	// A pipe's Write returns once the reader has taken every byte.
	if _, err := pw.Write(make([]byte, 300<<10)); err != nil {
		t.Fatal(err)
	}
	if r := s.Reading(); r < 300<<10-readAllowance {
		t.Fatalf("%d bytes counted while 300 KiB of a message sat in the read buffer", r)
	}
	go pw.Write(make([]byte, 1<<20))
	r := <-done
	if !errors.Is(r.err, errOverBudget) {
		t.Fatalf("reading past the budget: %d bytes, %v; want errOverBudget", len(r.data), r.err)
	}
	if r := s.Reading(); r != 0 {
		t.Fatalf("%d bytes still counted after the read stopped", r)
	}
}

// itemOverhead pays for a queued item's ring slot when the ring is as empty as it gets.
func TestItemOverheadCoversARingSlotAtAQuarterFull(t *testing.T) {
	if slot := unsafe.Sizeof(outItem{}); 4*slot > itemOverhead {
		t.Fatalf("a ring slot is %d bytes; itemOverhead %d covers less than four", slot, itemOverhead)
	}
}
