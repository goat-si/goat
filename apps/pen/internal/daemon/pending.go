package daemon

import (
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

const (
	// MaxPending caps queued account requests (oldest dropped); PendingTTL is how long one stays.
	MaxPending = 32
	PendingTTL = 24 * time.Hour
	// DenyTTL is how long pen deny refuses a key.
	DenyTTL = 24 * time.Hour
)

// Pending is a queued account join on a locked mesh.
type Pending struct {
	// ID is the first 8 characters of the fingerprint ("XXXX XXXX").
	ID          string     `json:"id"`
	Fingerprint string     `json:"fingerprint"`
	Name        string     `json:"name"`
	NodeID      string     `json:"nodeId"`
	SignPub     string     `json:"signPub"`
	Email       string     `json:"email"`
	Sub         string     `json:"sub"`
	Assertion   string     `json:"assertion"`
	At          int64      `json:"at"`
	Card        *mesh.Card `json:"card"`
}

type pendingFile struct {
	Pending []Pending        `json:"pending"`
	Denied  map[string]int64 `json:"denied"`
}

// pendingBook keeps pending.json: queued requests and keys denied for 24 hours.
type pendingBook struct {
	st     *state.Store
	mu     sync.Mutex
	list   []Pending
	denied map[string]int64
}

func loadPending(st *state.Store) (*pendingBook, error) {
	var f pendingFile
	if _, err := st.ReadJSON("pending.json", &f); err != nil {
		return nil, err
	}
	b := &pendingBook{st: st, denied: map[string]int64{}}
	for _, p := range f.Pending {
		if p.Card != nil && p.Card.Verify() == nil {
			b.list = append(b.list, p)
		}
	}
	for k, until := range f.Denied {
		b.denied[k] = until
	}
	return b, nil
}

func (b *pendingBook) pruneLocked(now time.Time) {
	b.list = slices.DeleteFunc(b.list, func(p Pending) bool { return now.Sub(time.UnixMilli(p.At)) >= PendingTTL })
	for k, until := range b.denied {
		if now.UnixMilli() >= until {
			delete(b.denied, k)
		}
	}
}

func (b *pendingBook) saveLocked() error {
	unlock, err := b.st.Lock()
	if err != nil {
		return err
	}
	defer unlock()
	return b.st.WriteJSON("pending.json", pendingFile{Pending: b.list, Denied: b.denied}, 0o600)
}

// add queues p, replacing an older request of the same key and dropping the oldest past 32.
func (b *pendingBook) add(p Pending, now time.Time) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pruneLocked(now)
	b.list = slices.DeleteFunc(b.list, func(x Pending) bool { return x.SignPub == p.SignPub })
	b.list = append(b.list, p)
	sort.SliceStable(b.list, func(i, j int) bool { return b.list[i].At < b.list[j].At })
	if len(b.list) > MaxPending {
		b.list = b.list[len(b.list)-MaxPending:]
	}
	return b.saveLocked()
}

func (b *pendingBook) all(now time.Time) []Pending {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pruneLocked(now)
	return append([]Pending(nil), b.list...)
}

func (b *pendingBook) isDenied(signPub string, now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	until, ok := b.denied[signPub]
	return ok && now.UnixMilli() < until
}

func normalizeFP(s string) string {
	return strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(s), " ", ""))
}

// find resolves a full fingerprint, or an 8-character id that exactly one request matches.
func (b *pendingBook) find(arg string, now time.Time) (Pending, error) {
	want := normalizeFP(arg)
	var hits []Pending
	for _, p := range b.all(now) {
		fp := normalizeFP(p.Fingerprint)
		if len(want) == len(fp) && want == fp || len(want) == 8 && strings.HasPrefix(fp, want) {
			hits = append(hits, p)
		}
	}
	switch {
	case len(hits) == 1:
		return hits[0], nil
	case len(hits) > 1:
		return Pending{}, fmt.Errorf("%d pending requests match %q; give the full fingerprint", len(hits), arg)
	case len(want) != 8 && len(want) != 40:
		return Pending{}, errors.New("give the request id (8 characters) or the full fingerprint (40)")
	}
	return Pending{}, fmt.Errorf("no pending request matches %q", arg)
}

// remove drops a request; deny also refuses its key for 24 hours.
func (b *pendingBook) remove(p Pending, deny bool, now time.Time) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.list = slices.DeleteFunc(b.list, func(x Pending) bool { return x.SignPub == p.SignPub })
	if deny {
		b.denied[p.SignPub] = now.Add(DenyTTL).UnixMilli()
	}
	return b.saveLocked()
}
