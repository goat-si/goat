// Package stream carries a TCP byte stream over a secure session: DATA, FIN and CREDIT records.
package stream

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"sync"

	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// Inner record types.
const (
	TypeData   byte = 0x00
	TypeFin    byte = 0x01
	TypeCredit byte = 0x02
)

const (
	// MaxData is the largest DATA payload in one record.
	MaxData = 65518
	// Window is the uncredited DATA a sender may have in flight.
	Window = 512 << 10
	// CreditEvery is how much consumed DATA triggers a CREDIT.
	CreditEvery = 64 << 10
)

// Link is the secure record channel a stream runs on.
type Link interface {
	Send(p []byte) error
	Recv(ctx context.Context) ([]byte, error)
	Close(code uint16) error
}

var errProtocol = &relay.CloseError{Code: wire.CodeCrypto}

// deliveredError is a Splice error that came after the peer's whole stream had reached w.
type deliveredError struct{ err error }

func (e *deliveredError) Error() string { return e.err.Error() }
func (e *deliveredError) Unwrap() error { return e.err }

// Delivered reports whether err is from a Splice that had already written everything the peer sent, up to its FIN,
// to w, so only the other direction was cut. A write still in progress when the error arrived counts as not
// delivered: Splice cannot wait on a reader that may never read. The decision is conservative: a caller that resets
// may drop bytes w had accepted but its reader had not read, and never ends a short stream cleanly.
func Delivered(err error) bool {
	var d *deliveredError
	return errors.As(err, &d)
}

// Splice copies r into the session and the session into w. It ends cleanly (nil) when both sides
// sent FIN and the peer's data reached w; closeWrite (may be nil) half-closes w at the peer's FIN.
// On error it closes the link and returns at once; the caller closes r and w to release the copy.
func Splice(ctx context.Context, link Link, r io.Reader, w io.Writer, closeWrite func() error) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	rctx, rcancel := context.WithCancel(ctx)
	defer rcancel()
	s := &splice{link: link, stopReader: rcancel}
	s.cond = sync.NewCond(&s.mu)
	errc := make(chan error, 3)
	go func() { errc <- s.sender(ctx, r) }()
	go func() { errc <- s.writer(w, closeWrite) }()
	go func() { errc <- s.reader(rctx) }()
	for range 3 {
		if err := <-errc; err != nil {
			s.fail(err)
			code := relay.CodeOf(err)
			if code == 0 {
				code = wire.CodeOffline
			}
			link.Close(code)
			if s.delivered() {
				return &deliveredError{err}
			}
			return err
		}
	}
	link.Close(wire.CodeNormal)
	return nil
}

type splice struct {
	link       Link
	stopReader context.CancelFunc

	mu       sync.Mutex
	cond     *sync.Cond
	failed   error
	inflight int // DATA payload sent and not yet credited to us
	pending  int // DATA payload received and not yet credited by us
	queue    [][]byte
	peerFin  bool
	sentFin  bool
	writing  bool // the writer holds DATA taken from queue that w has not yet returned from
}

// delivered reports whether the peer sent FIN and every DATA before it has been written to w. It reads the state
// itself, not the writer's progress, so a writer still busy after its last write (a CREDIT) does not hide it.
func (s *splice) delivered() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.peerFin && len(s.queue) == 0 && !s.writing
}

func (s *splice) fail(err error) {
	s.mu.Lock()
	if s.failed == nil {
		s.failed = err
	}
	s.mu.Unlock()
	s.cond.Broadcast()
}

func (s *splice) sender(ctx context.Context, r io.Reader) error {
	chunk := make([]byte, 1+MaxData)
	for {
		n, err := r.Read(chunk[1:])
		if n > 0 {
			s.mu.Lock()
			for s.inflight+n > Window && s.failed == nil {
				s.cond.Wait()
			}
			failed := s.failed
			s.inflight += n
			s.mu.Unlock()
			if failed != nil {
				return nil
			}
			chunk[0] = TypeData
			if err := s.link.Send(chunk[:1+n]); err != nil {
				return err
			}
		}
		if errors.Is(err, io.EOF) {
			s.mu.Lock()
			s.sentFin = true
			both := s.peerFin
			s.mu.Unlock()
			if err := s.link.Send([]byte{TypeFin}); err != nil {
				return err
			}
			if both {
				s.stopReader()
			}
			return nil
		}
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
	}
}

// reader dispatches records: DATA to the writer's queue, CREDIT to the sender. It keeps reading
// after the peer's FIN (CREDITs still arrive) until this side sent its own FIN.
func (s *splice) reader(ctx context.Context) error {
	for {
		rec, err := s.link.Recv(ctx)
		if err != nil {
			s.mu.Lock()
			done := s.peerFin && s.sentFin
			s.mu.Unlock()
			if done {
				return nil
			}
			return err
		}
		if len(rec) == 0 {
			return errProtocol
		}
		switch rec[0] {
		case TypeData:
			n := len(rec) - 1
			s.mu.Lock()
			if s.peerFin {
				s.mu.Unlock()
				return errProtocol
			}
			s.pending += n
			if s.pending > Window {
				s.mu.Unlock()
				return &relay.CloseError{Code: wire.CodeTimeout}
			}
			if n > 0 {
				s.queue = append(s.queue, rec[1:])
			}
			s.mu.Unlock()
			s.cond.Broadcast()
		case TypeFin:
			if len(rec) != 1 {
				return errProtocol
			}
			s.mu.Lock()
			if s.peerFin {
				s.mu.Unlock()
				return errProtocol
			}
			s.peerFin = true
			done := s.sentFin
			s.mu.Unlock()
			s.cond.Broadcast()
			if done {
				return nil
			}
		case TypeCredit:
			if len(rec) != 5 {
				return errProtocol
			}
			c := int(binary.LittleEndian.Uint32(rec[1:]))
			s.mu.Lock()
			if c > s.inflight {
				s.mu.Unlock()
				return errProtocol
			}
			s.inflight -= c
			s.mu.Unlock()
			s.cond.Broadcast()
		default:
			return errProtocol
		}
	}
}

func (s *splice) sendCredit(n int) error {
	s.mu.Lock()
	s.pending -= n
	s.mu.Unlock()
	rec := make([]byte, 5)
	rec[0] = TypeCredit
	binary.LittleEndian.PutUint32(rec[1:], uint32(n))
	return s.link.Send(rec)
}

// writer drains received DATA into w and credits what it consumed.
func (s *splice) writer(w io.Writer, closeWrite func() error) error {
	consumed := 0
	for {
		s.mu.Lock()
		for len(s.queue) == 0 && !s.peerFin && s.failed == nil {
			s.cond.Wait()
		}
		if s.failed != nil {
			s.mu.Unlock()
			return nil
		}
		if len(s.queue) == 0 {
			s.mu.Unlock()
			break
		}
		p := s.queue[0]
		s.queue[0] = nil
		s.queue = s.queue[1:]
		s.writing = true
		s.mu.Unlock()
		if _, err := w.Write(p); err != nil {
			return err
		}
		s.mu.Lock()
		s.writing = false
		s.mu.Unlock()
		consumed += len(p)
		if consumed >= CreditEvery {
			// Best effort: a peer that finished may close before our CREDIT; a dead link surfaces
			// in the reader, which sees the peer's FIN or the close in order.
			_ = s.sendCredit(consumed)
			consumed = 0
		}
	}
	if consumed > 0 {
		// The peer may already have closed after both FINs; this last credit is best effort.
		_ = s.sendCredit(consumed)
	}
	if closeWrite != nil {
		return closeWrite()
	}
	return nil
}
