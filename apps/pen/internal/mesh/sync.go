package mesh

import (
	"context"
	"errors"

	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// Merged is called with the records a sync stored; an error (they could not be saved) fails the
// sync, so the peer does not count them as taken.
type Merged func(added []*Record) error

// Version is what a v1.1 node announces in its sync hello, and VersionShared what a node announces for
// a mesh of the shared epoch (ADR-0026); such a node closes a sync whose peer announces anything else.
const (
	Version       = "1.1"
	VersionShared = "2.0"
)

// announce is the version s announces: a set of the shared epoch announces VersionShared whatever pen says.
func announce(s *Store, pen string) string {
	if s.Shared() {
		return VersionShared
	}
	return pen
}

// own is what this version announces for s. A set holding no records yet (joining) cannot know the epoch;
// it announces VersionShared, which a 1.1 node never sends, so a shared node serves it and takes the epoch
// from the found record, and refuses an empty 1.1 node.
func own(s *Store) string {
	if s.Len() == 0 {
		return VersionShared
	}
	return Version
}

// refuseEpoch closes l with 4509 when s is of the shared epoch and the peer did not announce it, whatever
// the peer holds.
func refuseEpoch(l Link, s *Store, m *Msg) error {
	if s.Shared() && m.Pen != VersionShared {
		l.Close(wire.CodeEpoch)
		return &relay.CloseError{Code: wire.CodeEpoch}
	}
	return nil
}

// Hello is called with the version the peer announced in its hello ("" for a v1.0 node).
type Hello func(pen string)

func (s *Store) hashes() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.recs))
	for h := range s.recs {
		out = append(out, h)
	}
	return out
}

func (s *Store) missingFrom(have []string) []*Record {
	known := make(map[string]bool, len(have))
	for _, h := range have {
		known[h] = true
	}
	var out []*Record
	for _, r := range s.Records() {
		if !known[r.Hash] {
			out = append(out, r)
		}
	}
	return out
}

// maxSessionRecords is the most records one mesh session may carry: everything an honest member
// can hold, stored and waiting. More means the peer is replaying lines to keep this side busy.
const maxSessionRecords = MaxRecords + MaxPool

// take merges one records line, cutting the session once it has carried more than
// maxSessionRecords; *received counts the records so far.
func (s *Store) take(l Link, m *Msg, onMerged Merged, received *int) error {
	*received += len(m.Records)
	if *received > maxSessionRecords {
		l.Close(errLine.Code)
		return errLine
	}
	added, err := s.Merge(m.Records)
	if len(added) > 0 && onMerged != nil {
		if err := onMerged(added); err != nil {
			l.Close(wire.CodeNotKept)
			return &relay.CloseError{Code: wire.CodeNotKept}
		}
	}
	// A record refused for the cap fails the sync, so the sender sees it was not taken.
	if errors.Is(err, ErrFull) {
		l.Close(wire.CodeMeshFull)
		return &relay.CloseError{Code: wire.CodeMeshFull}
	}
	return err
}

// SyncInitiate runs the dialing side of a mesh session. It returns once the peer's done arrived,
// which the responder sends only after it stored everything this side sent (the push was taken).
func SyncInitiate(ctx context.Context, l Link, s *Store, onMerged Merged, onHello Hello) error {
	return SyncInitiateAs(ctx, l, s, onMerged, onHello, own(s))
}

// SyncInitiateAs is SyncInitiate announcing pen in its hello ("" announces none, as v1.0 does).
func SyncInitiateAs(ctx context.Context, l Link, s *Store, onMerged Merged, onHello Hello, pen string) error {
	c := &Lines{L: l}
	pen = announce(s, pen)
	if err := c.Write(Msg{T: "hello", Pen: pen, Have: s.hashes()}); err != nil {
		return err
	}
	sentDone := false
	received := 0
	for {
		m, err := c.Read(ctx)
		if err != nil {
			return err
		}
		switch m.T {
		case "hello":
			if sentDone {
				l.Close(errLine.Code)
				return errLine
			}
			if err := refuseEpoch(l, s, m); err != nil {
				return err
			}
			if onHello != nil {
				onHello(m.Pen)
			}
			if err := c.writeRecords(s.missingFrom(m.Have)); err != nil {
				return err
			}
			if err := c.Write(Msg{T: "done"}); err != nil {
				return err
			}
			sentDone = true
		case "records":
			if err := s.take(l, m, onMerged, &received); err != nil {
				return err
			}
		case "done":
			if !sentDone {
				l.Close(errLine.Code)
				return errLine
			}
			return nil
		}
	}
}

// SyncRespond runs the accepting side. It sends its done only after the initiator's done, so the
// initiator learns its records were stored. The caller closes the link afterwards.
func SyncRespond(ctx context.Context, l Link, s *Store, onMerged Merged, onHello Hello) error {
	return SyncRespondAs(ctx, l, s, onMerged, onHello, own(s))
}

// SyncRespondAs is SyncRespond announcing pen in its hello.
func SyncRespondAs(ctx context.Context, l Link, s *Store, onMerged Merged, onHello Hello, pen string) error {
	c := &Lines{L: l}
	pen = announce(s, pen)
	if err := c.Write(Msg{T: "hello", Pen: pen, Have: s.hashes()}); err != nil {
		return err
	}
	gotHello := false
	received := 0
	for {
		m, err := c.Read(ctx)
		if err != nil {
			return err
		}
		switch m.T {
		case "hello":
			if gotHello {
				l.Close(errLine.Code)
				return errLine
			}
			gotHello = true
			if err := refuseEpoch(l, s, m); err != nil {
				return err
			}
			if onHello != nil {
				onHello(m.Pen)
			}
			if err := c.writeRecords(s.missingFrom(m.Have)); err != nil {
				return err
			}
		case "records":
			if err := s.take(l, m, onMerged, &received); err != nil {
				return err
			}
		case "done":
			if !gotHello {
				l.Close(errLine.Code)
				return errLine
			}
			// Done tells the initiator its records are kept. A set that still holds records it
			// could not write (an earlier sync, or this one with nothing new) tries again first.
			if onMerged != nil && s.Unsaved() {
				if err := onMerged(nil); err != nil {
					l.Close(wire.CodeNotKept)
					return &relay.CloseError{Code: wire.CodeNotKept}
				}
			}
			return c.Write(Msg{T: "done"})
		}
	}
}
