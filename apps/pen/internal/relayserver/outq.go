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
	// refs counts the source's sockets; guarded by srv.mu.
	refs int
}

// readAllowance is what one socket may hold for the message it is reading without a charge: a
// ping, an ack or a whole Noise message (64 KiB) always gets read, whoever fills the budgets.
// Past it a read charges the large-read pool (MaxReading) and the source's part of it.
const readAllowance = 4<<10 + firstGrowth

// firstGrowth is the read buffer after its first 4 KiB: room for a 96 KiB message and the byte
// that shows it ended, so such a message never needs the large-read pool.
const firstGrowth = 104 << 10

// reserve adds n to c unless that passes limit; c never passes limit, even for a moment.
func reserve(c *atomic.Int64, n, limit int64) bool {
	for {
		cur := c.Load()
		if cur+n > limit {
			return false
		}
		if c.CompareAndSwap(cur, cur+n) {
			return true
		}
	}
}

// try charges n bytes of queue to the source's share and the server-wide total, or charges
// nothing and reports false. A full relay ends nothing to make room: the caller's session ends.
func (b *budget) try(n int) bool {
	if b == nil {
		return true
	}
	if !reserve(&b.src.held, int64(n), b.srv.maxPerSource()) {
		return false
	}
	if !reserve(&b.srv.queued, int64(n), b.srv.maxQueued()) {
		b.src.held.Add(-int64(n))
		return false
	}
	return true
}

// release gives back n bytes of queue.
func (b *budget) release(n int) {
	if b == nil || n == 0 {
		return
	}
	b.srv.queued.Add(-int64(n))
	b.src.held.Add(-int64(n))
}

// tryRead charges n bytes of large reads, or nothing and false.
func (b *budget) tryRead(n int) bool {
	if b == nil {
		return true
	}
	if !reserve(&b.src.reading, int64(n), b.srv.maxReading()/8) {
		return false
	}
	if !reserve(&b.srv.reading, int64(n), b.srv.maxReading()) {
		b.src.reading.Add(-int64(n))
		return false
	}
	return true
}

// countRead gives back n bytes of large reads (n is never positive).
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
	// budget is what this queue charges for session data (nil in unit tests).
	budget *budget
	mu     sync.Mutex
	// ring holds the queued items from head; popped slots are cleared so a sent payload is not
	// kept alive by the array.
	ring  []outItem
	head  int
	n     int
	bytes int // what the queued items cost, writing excluded
	// charged is what of bytes the budget carries (session data; control messages are not
	// charged); writing and writingCharged are the same for the item being written.
	charged        int
	writing        int
	writingCharged int
	// reserved is charged room for session frames (OPEN, CLOSE) not queued yet; sessionBytes is
	// what session frames hold here, reserved or queued, at most sessionFrameRoom.
	reserved     int
	sessionBytes int
	// closeTimer bounds the closing write; writerDone is set when run returns.
	closeTimer *time.Timer
	writerDone bool
	// onWriteFail, when set, is called once a write fails or times out; failWrite, when set, can
	// fail a write before it starts as a stalled peer would (tests).
	onWriteFail func()
	failWrite   func() error
	bySID       map[uint32]int
	pongs       int
	done        bool
	wake        chan struct{}
	ended       chan struct{}
	// tallies, on an uplink, are the sessions whose delivered bytes this queue counts, until the
	// writer passes a session's end mark or the queue ends; own, on a client, is its session's.
	// writingTally is the one the item being written counts toward.
	tallies      map[uint32]*sessionTally
	own          *sessionTally
	writingTally *sessionTally
}

type outItem struct {
	data  []byte
	sid   uint32 // the client session a DATA frame on the uplink belongs to, else 0
	close uint16
	flags uint8
}

// Item flags: a text message, a pong, and session data the budget carries (control messages,
// the rest, are not charged). One byte keeps a ring slot at 32 bytes.
const (
	itemText uint8 = 1 << iota
	itemPong
	itemCharged
	itemSession
	// itemMark ends a session's frames on an uplink: the writer lets go of its tally there.
	itemMark
)

func (it outItem) is(f uint8) bool { return it.flags&f != 0 }

// itemOverhead is what each queued item costs beyond cap(data): its ring slot, at a quarter of
// the ring full at worst (the ring doubles when full and halves at a quarter). A queue's ring of
// minRing slots is part of the socket's fixed cost.
const itemOverhead = 128

const minRing = 8

func cost(it outItem) int { return cap(it.data) + itemOverhead }

func newOutq(ws wsWriter, timeout time.Duration, b *budget) *outq {
	q := &outq{ws: ws, timeout: timeout, budget: b, wake: make(chan struct{}, 1), ended: make(chan struct{})}
	go q.run()
	return q
}

// offerFrame queues a DATA frame for sid carrying payload, like offer: the frame is built in its
// own buffer only once its cost is charged, so no copy exists outside the budget.
func (q *outq) offerFrame(sid uint32, payload []byte) bool {
	n := wire.HeaderLen + len(payload)
	return q.offerBuilt(n, sid, func(buf []byte) {
		buf[0] = wire.FrameData
		binary.LittleEndian.PutUint32(buf[1:wire.HeaderLen], sid)
		copy(buf[wire.HeaderLen:], payload)
	})
}

// offer queues a copy of a session's data unless its cost would pass the source's share or the
// server-wide total; it reports whether it did. The cost is charged before the copy is made.
func (q *outq) offer(data []byte, sid uint32) bool {
	return q.offerBuilt(len(data), sid, func(buf []byte) { copy(buf, data) })
}

func (q *outq) offerBuilt(n int, sid uint32, fill func([]byte)) bool {
	reserved := itemOverhead
	if n > 0 {
		reserved += allocSize(n)
	}
	if !q.budget.try(reserved) {
		return false
	}
	var buf []byte
	if n > 0 {
		buf = own(nil, n)[:n]
		fill(buf)
	}
	it := outItem{data: buf, sid: sid, flags: itemCharged}
	// own sizes by allocSize, so the cost is what was reserved; charge any difference the same way.
	if d := cost(it) - reserved; d > 0 && !q.budget.try(d) {
		q.budget.release(reserved)
		return false
	} else if d < 0 {
		q.budget.release(-d)
	}
	q.push(it)
	return true
}

func (q *outq) binary(b []byte) { q.push(outItem{data: own(b, 0)}) }
func (q *outq) text(s string) {
	it := outItem{data: own([]byte(s), 0), flags: itemText}
	if s == "pong" {
		it.flags |= itemPong
	}
	q.push(it)
}

// push queues it. Session data comes charged (offer); control messages (the challenge, pongs,
// OPEN and CLOSE frames, the close frame) are not charged and are bounded per socket by the
// windows, maxQueuedPongs and the queue cap below.
func (q *outq) push(it outItem) {
	c := cost(it)
	q.mu.Lock()
	if q.done || it.is(itemPong) && q.pongs >= maxQueuedPongs {
		q.mu.Unlock()
		if it.is(itemCharged) {
			q.budget.release(c)
		}
		return
	}
	if it.close != 0 {
		q.done = true
	} else if q.bytes+q.writing+c > SocketWindow+RelayHeadroom+queueSlack {
		if it.is(itemCharged) {
			q.budget.release(c)
		}
		q.dropLocked()
		q.mu.Unlock()
		q.ws.CloseNow()
		q.signal()
		return
	}
	q.appendLocked(it)
	q.bytes += c
	if it.is(itemCharged) {
		q.charged += c
	}
	if it.sid != 0 {
		if q.bySID == nil {
			q.bySID = map[uint32]int{}
		}
		q.bySID[it.sid] += c
	}
	if it.is(itemPong) {
		q.pongs++
	}
	q.mu.Unlock()
	q.signal()
}

func (q *outq) appendLocked(it outItem) {
	if q.n == len(q.ring) {
		q.resize(max(minRing, 2*len(q.ring)))
	}
	q.ring[(q.head+q.n)%len(q.ring)] = it
	q.n++
}

// setOwn sets the tally a client's queue counts its session data toward.
func (q *outq) setOwn(t *sessionTally) {
	q.mu.Lock()
	q.own = t
	q.mu.Unlock()
}

// track has this uplink queue count sid's DATA toward t and hold t until the session's end mark
// is passed; it reports false, holding nothing, when the queue has ended or still holds sid.
func (q *outq) track(sid uint32, t *sessionTally) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.done || q.tallies[sid] != nil {
		return false
	}
	if q.tallies == nil {
		q.tallies = map[uint32]*sessionTally{}
	}
	t.refs.Add(1)
	q.tallies[sid] = t
	return true
}

// endSession queues sid's end mark behind its frames. The mark costs nothing: it takes one ring
// slot, and an uplink holds at most one per session it admitted.
func (q *outq) endSession(sid uint32) {
	q.mu.Lock()
	if q.tallies[sid] == nil {
		q.mu.Unlock()
		return
	}
	q.appendLocked(outItem{sid: sid, flags: itemMark})
	q.mu.Unlock()
	q.signal()
}

// delivered counts a written item toward t, the session it belongs to.
func delivered(it outItem, t *sessionTally) {
	if it.sid != 0 {
		t.toNode.Add(uint64(len(it.data) - wire.HeaderLen))
	} else {
		t.fromNode.Add(uint64(len(it.data)))
	}
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
	if it.is(itemMark) {
		return it
	}
	// Session data counts toward its session's tally, held until the write's result is counted:
	// a drop meanwhile must not count the session before this write.
	q.writingTally = nil
	if it.is(itemCharged) && !it.is(itemSession) {
		q.writingTally = q.own
		if it.sid != 0 {
			q.writingTally = q.tallies[it.sid]
		}
		if q.writingTally != nil {
			q.writingTally.refs.Add(1)
		}
	}
	c := cost(it)
	q.bytes -= c
	q.writing = c
	q.writingCharged = 0
	if it.is(itemCharged) {
		q.charged -= c
		q.writingCharged = c
	}
	if it.is(itemSession) {
		q.sessionBytes -= c
	}
	if it.sid != 0 {
		if q.bySID[it.sid] -= c; q.bySID[it.sid] == 0 {
			delete(q.bySID, it.sid)
		}
	}
	if it.is(itemPong) {
		q.pongs--
	}
	if len(q.ring) > minRing && q.n <= len(q.ring)/4 {
		q.resize(len(q.ring) / 2)
	}
	return it
}

// dropLocked ends the queue and gives back what its queued items cost and what it reserved, and
// lets go of the tallies it held.
func (q *outq) dropLocked() {
	q.done = true
	q.budget.release(q.charged + q.reserved)
	q.bytes, q.charged, q.reserved, q.sessionBytes = 0, 0, 0, 0
	q.ring, q.head, q.n, q.bySID = nil, 0, 0, nil
	tallies := q.tallies
	q.tallies = nil
	for _, t := range tallies {
		t.release()
	}
}

// queued reports what the queue holds for one session and in total, overhead included.
func (q *outq) queued(sid uint32) (mine, total int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.bySID[sid], q.bytes + q.writing + q.reserved
}

// sessionFrameCost is what one OPEN or CLOSE frame costs in a queue.
var sessionFrameCost = itemOverhead + allocSize(wire.HeaderLen+2)

// sessionFrameRoom bounds the session frames one uplink queue holds (about 960 sessions' OPEN and
// CLOSE), so clients that open and close faster than the node reads take at most this much of its
// window from the data of other sessions.
const sessionFrameRoom = 256 << 10

// reserve charges n bytes of room for frames queued later, within the window and the budget; it
// reports false, charging nothing, when they do not fit.
func (q *outq) reserve(n int) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.done || q.sessionBytes+n > sessionFrameRoom || q.bytes+q.writing+q.reserved+n > SocketWindow {
		return false
	}
	if !q.budget.try(n) {
		return false
	}
	q.reserved += n
	q.sessionBytes += n
	return true
}

// unreserve gives back n bytes reserve set aside that will not be used.
func (q *outq) unreserve(n int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.done {
		return
	}
	q.reserved -= n
	q.sessionBytes -= n
	q.budget.release(n)
}

// pushReserved queues b using n bytes reserve set aside.
func (q *outq) pushReserved(b []byte, n int) {
	it := outItem{data: own(b, 0), flags: itemCharged | itemSession}
	q.mu.Lock()
	if q.done {
		// dropLocked gave the reservation back.
		q.mu.Unlock()
		return
	}
	q.reserved -= n
	q.mu.Unlock()
	if d := cost(it) - n; d < 0 {
		q.budget.release(-d)
	} else if d > 0 {
		// Never: own sizes 7 bytes by allocSize. Charge it anyway rather than hold it uncounted.
		q.budget.try(d)
	}
	q.push(it)
}

// close queues the close frame; a writer still busy after the write timeout is aborted.
func (q *outq) close(code uint16) {
	q.push(outItem{close: code})
	t := time.AfterFunc(q.timeout, func() {
		select {
		case <-q.ended:
		default:
			q.ws.CloseNow()
		}
	})
	// The timer's function holds the queue and its socket: stop it once the writer has ended, or
	// every closed socket stays in memory for the write timeout.
	q.mu.Lock()
	ended := q.writerDone
	if !ended {
		q.closeTimer = t
	}
	q.mu.Unlock()
	if ended {
		t.Stop()
	}
}
func (q *outq) wait() { <-q.ended }

func (q *outq) writeFailed() {
	if q.onWriteFail != nil {
		q.onWriteFail()
	}
}

// written gives back the cost of the item the writer held.
func (q *outq) written() {
	q.mu.Lock()
	q.budget.release(q.writingCharged)
	q.writing, q.writingCharged = 0, 0
	q.mu.Unlock()
}

func (q *outq) run() {
	defer close(q.ended)
	defer func() {
		q.mu.Lock()
		// Whatever way the writer ends (a close frame written, a failed write), what the queue
		// still has charged or reserved goes back: an admitted session's unused CLOSE reservation
		// on an uplink that closed or was replaced included.
		q.dropLocked()
		q.writerDone = true
		t := q.closeTimer
		q.closeTimer = nil
		q.mu.Unlock()
		if t != nil {
			t.Stop()
		}
	}()
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
		held := q.writingTally
		q.writingTally = nil
		q.mu.Unlock()
		if it.is(itemMark) {
			q.mu.Lock()
			t := q.tallies[it.sid]
			delete(q.tallies, it.sid)
			q.mu.Unlock()
			if t != nil {
				t.release()
			}
			continue
		}
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
				q.writeFailed()
			}
			cancel()
			return
		}
		typ := websocket.MessageBinary
		if it.is(itemText) {
			typ = websocket.MessageText
		}
		var err error
		if q.failWrite != nil {
			err = q.failWrite()
		}
		if err == nil {
			wctx, cancel := context.WithTimeout(ctx, q.timeout)
			err = q.ws.Write(wctx, typ, it.data)
			cancel()
		}
		q.written()
		if err != nil {
			q.ws.CloseNow()
			q.writeFailed()
			q.mu.Lock()
			q.dropLocked()
			q.mu.Unlock()
			if held != nil {
				held.release()
			}
			return
		}
		if held != nil {
			delivered(it, held)
			held.release()
		}
	}
}
