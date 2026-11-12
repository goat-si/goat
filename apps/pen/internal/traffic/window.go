// Package traffic counts the stream bytes a node carries to each member over each relay for the last 24 hours.
package traffic

import (
	"cmp"
	"errors"
	"math"
	"slices"
	"sync"
	"time"
)

const (
	// Span is one bucket. Bytes leave the total between 24 h minus Span and 24 h after they were counted.
	Span = 15 * time.Minute
	// Buckets cover 24 hours.
	Buckets = int64(24 * time.Hour / Span)
	// MaxEntries bounds the (member, relay) pairs held at once: about 2.3 KiB each, 1.2 MiB in all.
	MaxEntries = 512
)

// ErrFull refuses a new (member, relay) pair while MaxEntries pairs still hold bytes from the last 24 hours.
var ErrFull = errors.New("traffic: too many members and relays counted")

type key struct{ member, relay string }

type bucket struct {
	idx     int64
	in, out uint64
}

type entry [Buckets]bucket

// Window keeps, per member and relay, the bytes in and out of the last 24 hours in fixed buckets.
type Window struct {
	now  func() time.Time
	made time.Time

	mu      sync.Mutex
	entries map[key]*entry
	// pruned is the bucket of the last sweep for empty entries, so a flood of new keys while full sweeps at most
	// once per bucket.
	pruned int64
}

// NewWindow reads the wall clock through now.
func NewWindow(now func() time.Time) *Window {
	return &Window{now: now, made: now().Round(0), entries: map[key]*entry{}, pruned: math.MinInt64}
}

// Since is where the totals start: when the window was made, or 24 hours ago if that is later. Both are wall clock
// readings (Round(0) drops the monotonic one), as the buckets are.
func (w *Window) Since() time.Time {
	if s := w.now().Round(0).Add(-24 * time.Hour); s.After(w.made) {
		return s
	}
	return w.made
}

func bucketOf(t time.Time) int64 { return t.UnixNano() / int64(Span) }

// AddSat adds without wrapping: a sum past MaxUint64 stays MaxUint64.
func AddSat(a, b uint64) uint64 {
	if s := a + b; s >= a {
		return s
	}
	return math.MaxUint64
}

// sum is the entry's total over the 24 hours ending in bucket now. Buckets up to 24 hours ahead of now count too, so
// a wall clock set back neither hides recent bytes nor lets a sweep drop them.
func (e *entry) sum(now int64) (in, out uint64) {
	for i := range e {
		if b := &e[i]; b.idx > now-Buckets && b.idx < now+Buckets {
			in, out = AddSat(in, b.in), AddSat(out, b.out)
		}
	}
	return in, out
}

// Add counts in and out bytes for member over relay now.
func (w *Window) Add(member, relay string, in, out uint64) error {
	if in == 0 && out == 0 {
		return nil
	}
	now := bucketOf(w.now())
	w.mu.Lock()
	defer w.mu.Unlock()
	k := key{member, relay}
	e := w.entries[k]
	if e == nil {
		if len(w.entries) >= MaxEntries && !w.pruneLocked(now) {
			return ErrFull
		}
		e = new(entry)
		w.entries[k] = e
	}
	b := &e[((now%Buckets)+Buckets)%Buckets]
	if b.idx != now {
		*b = bucket{idx: now}
	}
	b.in, b.out = AddSat(b.in, in), AddSat(b.out, out)
	return nil
}

// pruneLocked drops entries with nothing left in the window and reports whether there is room for one more.
func (w *Window) pruneLocked(now int64) bool {
	if w.pruned != now {
		w.pruned = now
		for k, e := range w.entries {
			if in, out := e.sum(now); in == 0 && out == 0 {
				delete(w.entries, k)
			}
		}
	}
	return len(w.entries) < MaxEntries
}

// Total is one member's bytes over one relay in the last 24 hours.
type Total struct {
	Member, Relay string
	In, Out       uint64
}

// Totals lists the pairs with bytes in the last 24 hours, by member then relay.
func (w *Window) Totals() []Total {
	now := bucketOf(w.now())
	w.mu.Lock()
	defer w.mu.Unlock()
	var out []Total
	for k, e := range w.entries {
		if in, o := e.sum(now); in != 0 || o != 0 {
			out = append(out, Total{Member: k.member, Relay: k.relay, In: in, Out: o})
		}
	}
	slices.SortFunc(out, func(a, b Total) int {
		return cmp.Or(cmp.Compare(a.Member, b.Member), cmp.Compare(a.Relay, b.Relay))
	})
	return out
}

// Len is the number of pairs held, empty ones not yet swept included.
func (w *Window) Len() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.entries)
}
