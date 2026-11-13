package daemon

import (
	"context"
	"io"
	"net"
	"sync"
	"time"
)

// holderQueueCap bounds the lines waiting for a registration's holder: an honest holder has at most one answer and two
// events per invite outstanding, because it sends one op at a time and waits for each answer.
const holderQueueCap = 16

// holderEntry is one line for a holder, reserved in the order of the change it reports (contract "Ops on the
// registration"): an answer may be reserved before its text is known and becomes ready later.
type holderEntry struct {
	line    []byte
	ready   chan struct{}
	written chan struct{}
	// filling, when set, runs as fill makes the entry ready, on the filling goroutine (tests).
	filling func()
	// ok and done are guarded by holderQueue.mu; ok is final once written is closed.
	ok   bool
	done bool
}

// holderQueue writes a registration's answers and events strictly in order, from one goroutine. Once it fails (a write
// error or deadline, a full queue, or the registration ending) it is terminal: every waiter is released, the rest is
// dropped, and the holder's connection is closed, which ends the registration.
type holderQueue struct {
	conn net.Conn
	// drain discards and closes the connection after its half-close (discardAndClose), off the caller's path.
	drain func(net.Conn)
	// wmu holds one write at a time, so failWith's line never splits another; broken (guarded by wmu) is set once a
	// write failed, possibly part way through a line, after which nothing more is written.
	wmu    sync.Mutex
	broken bool
	// whileWriting, when set, runs once the writer holds wmu for a ready entry, before it checks and writes (tests).
	whileWriting func()
	// whileFilling, when set, is copied into each entry this queue reserves (tests).
	whileFilling func()
	mu           sync.Mutex
	entries      []*holderEntry
	failed       bool
	wake         chan struct{}
	dead         chan struct{}
	once         sync.Once
}

func newHolderQueue(c net.Conn, drain func(net.Conn)) *holderQueue {
	return &holderQueue{conn: c, drain: drain, wake: make(chan struct{}, 1), dead: make(chan struct{})}
}

// reserve appends an entry whose line is set later by fill; ok is false once the queue failed or is full (and then the
// queue fails).
func (q *holderQueue) reserve() (*holderEntry, bool) {
	q.mu.Lock()
	if q.failed {
		q.mu.Unlock()
		return nil, false
	}
	if len(q.entries) >= holderQueueCap {
		q.mu.Unlock()
		q.fail()
		return nil, false
	}
	e := &holderEntry{ready: make(chan struct{}), written: make(chan struct{}), filling: q.whileFilling}
	q.entries = append(q.entries, e)
	q.mu.Unlock()
	select {
	case q.wake <- struct{}{}:
	default:
	}
	return e, true
}

// push appends a ready line.
func (q *holderQueue) push(line []byte) (*holderEntry, bool) {
	e, ok := q.reserve()
	if ok {
		e.fill(line)
	}
	return e, ok
}

// fill sets a reserved entry's line and lets the writer reach it.
func (e *holderEntry) fill(line []byte) {
	if e.filling != nil {
		e.filling()
	}
	e.line = line
	close(e.ready)
}

// wait blocks until e was written (true) or the queue failed before writing it (false).
func (q *holderQueue) wait(e *holderEntry) bool {
	<-e.written
	q.mu.Lock()
	defer q.mu.Unlock()
	return e.ok
}

func (q *holderQueue) finish(e *holderEntry, ok bool) {
	if !e.done {
		e.done, e.ok = true, ok
		close(e.written)
	}
}

// run writes entries in order until the queue fails.
func (q *holderQueue) run() {
	for {
		q.mu.Lock()
		for len(q.entries) == 0 && !q.failed {
			q.mu.Unlock()
			select {
			case <-q.wake:
			case <-q.dead:
			}
			q.mu.Lock()
		}
		if q.failed {
			q.mu.Unlock()
			return
		}
		e := q.entries[0]
		q.mu.Unlock()
		select {
		case <-e.ready:
		case <-q.dead:
			return
		}
		q.wmu.Lock()
		if q.whileWriting != nil {
			q.whileWriting()
		}
		q.mu.Lock()
		failed := q.failed
		q.mu.Unlock()
		var err error
		// Checked with write ownership held: once failWith has marked the queue, no queued line starts.
		if failed || q.broken {
			err = net.ErrClosed
		} else if _, err = q.conn.Write(e.line); err != nil {
			q.broken = true
		}
		q.wmu.Unlock()
		q.mu.Lock()
		if len(q.entries) > 0 && q.entries[0] == e {
			q.entries = q.entries[1:]
		}
		q.finish(e, err == nil)
		q.mu.Unlock()
		if err != nil {
			q.fail()
			return
		}
	}
}

// fail makes the queue terminal and closes the holder's connection.
func (q *holderQueue) fail() {
	q.failWith(nil)
}

// failWith makes the queue terminal, writes last (when not nil) after any write in progress and without waiting on
// unready entries, then ends the holder's connection. Each write is bounded by the control write deadline. After a
// failed write it writes nothing, so a partial line is never followed by another.
func (q *holderQueue) failWith(last []byte) {
	q.once.Do(func() {
		q.mu.Lock()
		q.failed = true
		for _, e := range q.entries {
			q.finish(e, false)
		}
		q.entries = nil
		q.mu.Unlock()
		close(q.dead)
		// Write ownership is held until the write side is shut (half-closed or closed), so no queued write can
		// start after the last line.
		q.wmu.Lock()
		if last != nil && !q.broken {
			q.conn.Write(last)
		}
		// A close with input unread resets the connection, and on Windows the reset can discard lines the holder has
		// not read yet: half-close and discard what the holder still sends, off this path, before closing. The
		// connection keeps its control slot until that close, so controlConnCap also bounds the drains.
		if cw, ok := q.conn.(interface{ CloseWrite() error }); ok && cw.CloseWrite() == nil {
			q.wmu.Unlock()
			q.drain(q.conn)
			return
		}
		q.conn.Close()
		q.wmu.Unlock()
	})
}

// discardAndClose reads c until the holder closes its side, holderDrainTime passes, holderDrainCap bytes came or stop
// ends, then closes c.
func discardAndClose(stop context.Context, c net.Conn) {
	defer c.Close()
	defer context.AfterFunc(stop, func() { c.Close() })()
	if c.SetReadDeadline(time.Now().Add(holderDrainTime)) == nil {
		io.Copy(io.Discard, io.LimitReader(c, holderDrainCap))
	}
}
