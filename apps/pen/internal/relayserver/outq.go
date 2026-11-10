package relayserver

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// budget is what one socket's queue and reader charge: the server-wide totals and the share of the
// socket's source address. Every byte the relay holds for a socket's messages is charged before it
// is allocated and until it is released, so the caps bound memory rather than payload sizes.
type budget struct {
	srv *Server
	src *source
}

// source is one source address's part of the server-wide totals.
type source struct {
	held    atomic.Int64 // queued
	reading atomic.Int64 // large reads, past readAllowance
	// refs counts the source's sockets and queues are their queues, for eviction; both guarded
	// by srv.mu.
	refs   int
	queues map[*outq]struct{}
}

// readAllowance is what one socket may hold for the message it is reading without a charge: a
// ping, an ack or a whole Noise message (64 KiB) always gets read, whoever fills the budgets.
// Past it a read charges the large-read pool (MaxReading) and the source's part of it.
const readAllowance = 4<<10 + firstGrowth

// firstGrowth is the read buffer after its first 4 KiB: room for a 96 KiB message and the byte
// that shows it ended, so such a message never needs the large-read pool.
const firstGrowth = 104 << 10

// try charges n bytes of queue, or charges nothing and reports false; shareFull says the source's
// share refused it rather than the server-wide total.
func (b *budget) try(n int) (ok, shareFull bool) {
	if b == nil {
		return true, false
	}
	if b.src.held.Add(int64(n)) > b.srv.maxPerSource() {
		b.src.held.Add(-int64(n))
		return false, true
	}
	if b.srv.queued.Add(int64(n)) > b.srv.maxQueued() {
		b.srv.queued.Add(-int64(n))
		b.src.held.Add(-int64(n))
		return false, false
	}
	return true, false
}

// tryEvicting charges n bytes for self like try. When a cap refuses, it ends one stalled queue
// (Server.endStalled) and tries again, until the charge fits or no stalled queue ranks before
// self. Only data a node sends its client uses it.
func (b *budget) tryEvicting(n int, self *outq) bool {
	for {
		ok, shareFull := b.try(n)
		if ok {
			return true
		}
		var within *source
		if shareFull {
			within = b.src
		}
		if !b.srv.endStalled(within, b.src, self) {
			return false
		}
	}
}

// stallAfter is how long a queue holding memory may go without a finished write and still count
// as draining; only stalled queues are ended to make room.
const stallAfter = 2 * time.Second

// count charges n bytes of queue (negative to give them back) without checking the caps: control
// messages are small and bounded per socket.
func (b *budget) count(n int) {
	if b == nil || n == 0 {
		return
	}
	b.srv.queued.Add(int64(n))
	b.src.held.Add(int64(n))
}

// tryRead charges n bytes of large reads, or nothing and false.
func (b *budget) tryRead(n int) bool {
	if b == nil {
		return true
	}
	if b.srv.reading.Add(int64(n)) > b.srv.maxReading() {
		b.srv.reading.Add(-int64(n))
		return false
	}
	if b.src.reading.Add(int64(n)) > b.srv.maxReading()/8 {
		b.src.reading.Add(-int64(n))
		b.srv.reading.Add(-int64(n))
		return false
	}
	return true
}

func (b *budget) countRead(n int) {
	if b == nil || n == 0 {
		return
	}
	b.srv.reading.Add(int64(n))
	b.src.reading.Add(int64(n))
}

var errOverBudget = errors.New("relay: the queue budget is spent")

// allocSize is what the allocator takes for an n-byte buffer, at most: up to 32 KiB a size class
// (never above the next power of two), past it whole 8 KiB pages.
func allocSize(n int) int {
	if n <= 32<<10 {
		p := 8
		for p < n {
			p <<= 1
		}
		return p
	}
	return (n + 8191) &^ 8191
}

// readMessage reads one message of at most limit+1 bytes. Its buffers are charged before they are
// allocated, past readAllowance, and while the buffer grows both the old and the new one count.
// The caller gives back what readCharge reports for the returned buffer once it is done with it;
// on an error nothing stays charged.
func readMessage(r io.Reader, limit int, b *budget) (data []byte, err error) {
	charged := 0
	hold := func(held int) bool {
		want := max(0, held-readAllowance)
		if want > charged && !b.tryRead(want-charged) {
			return false
		}
		if want < charged {
			b.countRead(want - charged)
		}
		charged = want
		return true
	}
	size := 4 << 10
	if !hold(size) {
		return nil, errOverBudget
	}
	buf := own(nil, size)
	for {
		if len(buf) == cap(buf) {
			if len(buf) > limit {
				return buf, nil
			}
			next := allocSize(min(max(2*cap(buf), firstGrowth), limit+1))
			if !hold(cap(buf) + next) {
				b.countRead(-charged)
				return nil, errOverBudget
			}
			buf = own(buf, next)
			hold(cap(buf))
		}
		n, err := r.Read(buf[len(buf):cap(buf)])
		buf = buf[:len(buf)+n]
		if err == io.EOF {
			return buf, nil
		}
		if err != nil {
			b.countRead(-charged)
			return nil, err
		}
	}
}

// readCharge is what readMessage left charged for a buffer of capacity c.
func readCharge(c int) int { return max(0, c-readAllowance) }

// own copies p into a new buffer with room for at least size bytes, sized to the allocator's size
// class so cap is the memory it takes. It never aliases p: a payload sliced from a read buffer
// would keep the whole buffer alive.
func own(p []byte, size int) []byte {
	size = max(size, len(p))
	if size == 0 {
		return nil
	}
	b := append([]byte(nil), make([]byte, size)...)
	return b[:copy(b, p)]
}

// outq sends a socket's messages in order from one goroutine, so the room never blocks on a slow
// peer. The contract windows bound what it holds; past them plus slack the socket is aborted.
// wsWriter is the part of a WebSocket the out queue uses.
type wsWriter interface {
	Write(ctx context.Context, typ websocket.MessageType, p []byte) error
	Close(code websocket.StatusCode, reason string) error
	CloseNow() error
}

type outq struct {
	ws      wsWriter
	timeout time.Duration
	// budget is what this queue charges (nil in unit tests).
	budget *budget
	// uplink marks a node's queue, ended only after every stalled client queue.
	uplink bool
	mu     sync.Mutex
	// since is when the queue last finished a write, or took its first item while empty.
	since time.Time
	// ring holds the queued items from head; popped slots are cleared so a sent payload is not
	// kept alive by the array.
	ring  []outItem
	head  int
	n     int
	bytes int // what the queued items cost, writing excluded
	// writing is the cost of the item being written, charged until the write returns.
	writing int
	bySID   map[uint32]int
	pongs   int
	done    bool
	wake    chan struct{}
	ended   chan struct{}
}

type outItem struct {
	data  []byte
	text  bool
	pong  bool
	close uint16
	sid   uint32 // the client session a DATA frame on the uplink belongs to, else 0
}

// itemOverhead is what each queued item costs beyond cap(data): its ring slot, at a quarter of
// the ring full at worst (the ring doubles when full and halves at a quarter). A queue's ring of
// minRing slots is part of the socket's fixed cost.
const itemOverhead = 128

const minRing = 8

func cost(it outItem) int { return cap(it.data) + itemOverhead }

func newOutq(ws wsWriter, timeout time.Duration, b *budget, uplink bool) *outq {
	q := &outq{ws: ws, timeout: timeout, budget: b, uplink: uplink, wake: make(chan struct{}, 1), ended: make(chan struct{})}
	if b != nil {
		b.srv.mu.Lock()
		b.src.queues[q] = struct{}{}
		b.srv.mu.Unlock()
	}
	go q.run()
	return q
}

// offerFrame queues a DATA frame for sid carrying payload, like offer: the frame is built in its
// own buffer only once its cost is charged, so no copy exists outside the budget.
func (q *outq) offerFrame(sid uint32, payload []byte) bool {
	n := wire.HeaderLen + len(payload)
	reserved := itemOverhead + allocSize(n)
	if ok, _ := q.budget.try(reserved); !ok {
		return false
	}
	buf := own(nil, n)[:n]
	buf[0] = wire.FrameData
	binary.LittleEndian.PutUint32(buf[1:wire.HeaderLen], sid)
	copy(buf[wire.HeaderLen:], payload)
	it := outItem{data: buf, sid: sid}
	q.budget.count(cost(it) - reserved)
	q.push(it, true)
	return true
}

// offer queues a copy of a session's data unless its cost would pass the source's share, or the
// server's total with nothing larger to end; it reports whether it did. The cost is charged before
// the copy is made.
func (q *outq) offer(data []byte, sid uint32) bool {
	reserved := itemOverhead
	if len(data) > 0 {
		reserved += allocSize(len(data))
	}
	if !q.budget.tryEvicting(reserved, q) {
		return false
	}
	it := outItem{data: own(data, 0), sid: sid}
	q.budget.count(cost(it) - reserved)
	q.push(it, true)
	return true
}

func (q *outq) now() time.Time {
	if q.budget != nil && q.budget.srv.clock != nil {
		return q.budget.srv.clock()
	}
	return time.Now()
}

// rank is what endStalled orders queues by; ok is false for a queue that is not stalled, holds
// nothing, or was already ended with nothing left but its write in flight.
type rank struct {
	held   int
	age    time.Duration
	uplink bool
}

func (q *outq) rank(now time.Time) (r rank, ok bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	held := q.bytes + q.writing
	age := now.Sub(q.since)
	if held == 0 || q.done && q.bytes == 0 || age < stallAfter {
		return rank{}, false
	}
	return rank{held: held, age: age, uplink: q.uplink}, true
}

// endsBefore reports whether a full relay ends a stalled queue ranked r before one ranked o: a
// client's before an uplink's (which takes its sessions with it), then the longest stalled, then
// the larger.
func (r rank) endsBefore(o rank) bool {
	switch {
	case r.uplink != o.uplink:
		return !r.uplink
	case r.age != o.age:
		return r.age > o.age
	}
	return r.held > o.held
}

// endIfStalled ends the queue if it is still stalled, checked under its own lock (it may have
// drained since it was ranked): it gives back what it has queued at once, and the message being
// written once the closed socket fails the write. The socket closes in the background, so the
// caller, which holds its room's lock, never waits.
func (q *outq) endIfStalled() bool {
	q.mu.Lock()
	if q.bytes+q.writing == 0 || q.done && q.bytes == 0 || q.now().Sub(q.since) < stallAfter {
		q.mu.Unlock()
		return false
	}
	q.dropLocked()
	q.mu.Unlock()
	q.signal()
	go q.ws.CloseNow()
	return true
}

func (q *outq) binary(b []byte) { q.push(outItem{data: own(b, 0)}, false) }
func (q *outq) text(s string) {
	q.push(outItem{data: own([]byte(s), 0), text: true, pong: s == "pong"}, false)
}

// push queues it; charged says whether offer already charged its cost.
func (q *outq) push(it outItem, charged bool) {
	c := cost(it)
	q.mu.Lock()
	if q.done || it.pong && q.pongs >= maxQueuedPongs {
		q.mu.Unlock()
		if charged {
			q.budget.count(-c)
		}
		return
	}
	if !charged {
		q.budget.count(c)
	}
	if q.bytes == 0 && q.writing == 0 {
		q.since = q.now()
	}
	if it.close != 0 {
		q.done = true
	} else if q.bytes+q.writing+c > SocketWindow+RelayHeadroom+queueSlack {
		q.budget.count(-c)
		q.dropLocked()
		q.mu.Unlock()
		q.ws.CloseNow()
		q.signal()
		return
	}
	if q.n == len(q.ring) {
		q.resize(max(minRing, 2*len(q.ring)))
	}
	q.ring[(q.head+q.n)%len(q.ring)] = it
	q.n++
	q.bytes += c
	if it.sid != 0 {
		if q.bySID == nil {
			q.bySID = map[uint32]int{}
		}
		q.bySID[it.sid] += c
	}
	if it.pong {
		q.pongs++
	}
	q.mu.Unlock()
	q.signal()
}

func (q *outq) signal() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

func (q *outq) resize(n int) {
	r := make([]outItem, n)
	for i := range q.n {
		r[i] = q.ring[(q.head+i)%len(q.ring)]
	}
	q.ring, q.head = r, 0
}

// pop takes the oldest item, still charged: the writer gives its cost back once written.
func (q *outq) pop() outItem {
	it := q.ring[q.head]
	q.ring[q.head] = outItem{}
	q.head = (q.head + 1) % len(q.ring)
	q.n--
	c := cost(it)
	q.bytes -= c
	q.writing = c
	if it.sid != 0 {
		if q.bySID[it.sid] -= c; q.bySID[it.sid] == 0 {
			delete(q.bySID, it.sid)
		}
	}
	if it.pong {
		q.pongs--
	}
	if len(q.ring) > minRing && q.n <= len(q.ring)/4 {
		q.resize(len(q.ring) / 2)
	}
	return it
}

// dropLocked ends the queue and gives back what its queued items cost.
func (q *outq) dropLocked() {
	q.done = true
	q.budget.count(-q.bytes)
	q.bytes = 0
	q.ring, q.head, q.n, q.bySID = nil, 0, 0, nil
}

// queued reports what the queue holds for one session and in total, overhead included.
func (q *outq) queued(sid uint32) (mine, total int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.bySID[sid], q.bytes + q.writing
}

// close queues the close frame; a writer still busy after the write timeout is aborted.
func (q *outq) close(code uint16) {
	q.push(outItem{close: code}, false)
	time.AfterFunc(q.timeout, func() {
		select {
		case <-q.ended:
		default:
			q.ws.CloseNow()
		}
	})
}
func (q *outq) wait() { <-q.ended }

// written gives back the cost of the item the writer held.
func (q *outq) written() {
	q.mu.Lock()
	q.budget.count(-q.writing)
	q.writing = 0
	q.since = q.now()
	q.mu.Unlock()
}

func (q *outq) run() {
	defer close(q.ended)
	if b := q.budget; b != nil {
		defer func() {
			b.srv.mu.Lock()
			delete(b.src.queues, q)
			b.srv.mu.Unlock()
		}()
	}
	ctx := context.Background()
	for {
		q.mu.Lock()
		if q.n == 0 {
			if q.done {
				q.mu.Unlock()
				return
			}
			q.mu.Unlock()
			<-q.wake
			continue
		}
		it := q.pop()
		q.mu.Unlock()
		if it.close != 0 {
			q.written()
			cctx, cancel := context.WithTimeout(ctx, q.timeout)
			done := make(chan struct{})
			go func() {
				q.ws.Close(websocket.StatusCode(it.close), "")
				close(done)
			}()
			select {
			case <-done:
			case <-cctx.Done():
				q.ws.CloseNow()
			}
			cancel()
			return
		}
		typ := websocket.MessageBinary
		if it.text {
			typ = websocket.MessageText
		}
		wctx, cancel := context.WithTimeout(ctx, q.timeout)
		err := q.ws.Write(wctx, typ, it.data)
		cancel()
		q.written()
		if err != nil {
			q.ws.CloseNow()
			q.mu.Lock()
			q.dropLocked()
			q.mu.Unlock()
			return
		}
	}
}
