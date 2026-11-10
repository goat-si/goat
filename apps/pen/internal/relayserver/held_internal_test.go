package relayserver

import (
	"bytes"
	"context"
	"errors"
	"io"
	"runtime"
	"testing"
	"time"
	"unsafe"

	"github.com/coder/websocket"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// heapInUse is the bytes live on the heap after a full collection.
func heapInUse() int64 {
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return int64(m.HeapAlloc)
}

// A frame the relay read stays in memory for as long as its payload waits in a client's queue, and
// with it the buffer it was read into. The server-wide count has to cover all of that, or a budget
// that looks full at 192 MiB can hold several times as much.
func TestTheQueueCountCoversTheMemoryQueuedFramesHold(t *testing.T) {
	s := New(DefaultLimits())
	ws := &stalledWS{release: make(chan struct{})}
	defer close(ws.release)
	rm := &room{srv: s, clients: map[uint32]*sock{}}
	up := testSock(s, rm, roleNode, 0, "192.0.2.1", ws)
	c := testSock(s, rm, roleClient, 1, "192.0.2.2", ws)
	frame := wire.Frame{Type: wire.FrameData, SID: 1, Payload: []byte{}}.Encode()
	before := heapInUse()
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
	held := heapInUse() - before
	if c.closed {
		t.Fatal("the session ended; the test needs it to keep queueing")
	}
	if q := s.Queued(); q < held {
		t.Fatalf("the relay counts %d queued bytes while the queue holds %d", q, held)
	}
	runtime.KeepAlive(c)
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
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Once the writer has sent an item, nothing in the queue may keep its payload alive: the count
// dropped when it left, so memory that stays behind would be uncounted.
func TestADrainedQueueKeepsNoSentPayloadAlive(t *testing.T) {
	ws := &countingWS{stalledWS: stalledWS{release: make(chan struct{})}, wrote: make(chan struct{})}
	defer close(ws.release)
	q := newOutq(ws, time.Hour, testBudget(New(DefaultLimits()), "192.0.2.1"))
	before := heapInUse()
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
	if held := heapInUse() - before; held > 64<<10 {
		t.Fatalf("an emptied queue still holds %d bytes of sent payloads", held)
	}
	runtime.KeepAlive(q)
}

// A message the relay is still reading holds memory as well: it counts toward the budget while it
// grows, and a message that would pass the budget stops being read.
func TestAPartlyReadMessageCountsTowardTheBudgetUntilItWouldPassIt(t *testing.T) {
	s := New(DefaultLimits())
	s.MaxQueued = 1 << 20
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
	if q := s.Queued(); q < 300<<10 {
		t.Fatalf("%d bytes counted while 300 KiB of a message sat in the read buffer", q)
	}
	go pw.Write(make([]byte, 1<<20))
	r := <-done
	if !errors.Is(r.err, errOverBudget) {
		t.Fatalf("reading past the budget: %d bytes, %v; want errOverBudget", len(r.data), r.err)
	}
	if q := s.Queued(); q != 0 {
		t.Fatalf("%d bytes still counted after the read stopped", q)
	}
}

// itemOverhead pays for a queued item's ring slot when the ring is as empty as it gets.
func TestItemOverheadCoversARingSlotAtAQuarterFull(t *testing.T) {
	if slot := unsafe.Sizeof(outItem{}); 4*slot > itemOverhead {
		t.Fatalf("a ring slot is %d bytes; itemOverhead %d covers less than four", slot, itemOverhead)
	}
}
