package daemon

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/login"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

// ForgetsFile keeps registry forgets the login service has not answered yet.
const ForgetsFile = "forgets.json"

const (
	forgetFirstRetry = 30 * time.Second
	forgetMaxRetry   = time.Hour
)

// PendingForget is a registry forget to send again.
type PendingForget struct {
	NodeID   string `json:"nodeId"`
	LoginURL string `json:"loginUrl"`
}

// savedForget is a forgets.json entry; Refused keeps the 403 notice across restarts (older pen
// ignores the field).
type savedForget struct {
	PendingForget
	Refused bool `json:"refused,omitempty"`
}

type forgetBook struct {
	st   *state.Store
	mu   sync.Mutex
	list []PendingForget
	// refused marks forgets the service last answered 403: retrying cannot help until this node is
	// registered under the account, so ls shows them.
	refused map[PendingForget]bool
	kick    chan struct{}
}

func loadForgets(st *state.Store) (*forgetBook, error) {
	b := &forgetBook{st: st, kick: make(chan struct{}, 1), refused: map[PendingForget]bool{}}
	var saved []savedForget
	if _, err := st.ReadJSON(ForgetsFile, &saved); err != nil {
		return nil, err
	}
	for _, s := range saved {
		b.list = append(b.list, s.PendingForget)
		if s.Refused {
			b.refused[s.PendingForget] = true
		}
	}
	return b, nil
}

func (b *forgetBook) saveLocked() error {
	unlock, err := b.st.Lock()
	if err != nil {
		return err
	}
	defer unlock()
	list := []savedForget{}
	for _, f := range b.list {
		list = append(list, savedForget{PendingForget: f, Refused: b.refused[f]})
	}
	return b.st.WriteJSON(ForgetsFile, list, 0o600)
}

// add queues forgets and wakes the sender.
func (b *forgetBook) add(fs []PendingForget) error {
	b.mu.Lock()
	for _, f := range fs {
		if !slices.Contains(b.list, f) {
			b.list = append(b.list, f)
		}
	}
	err := b.saveLocked()
	b.mu.Unlock()
	select {
	case b.kick <- struct{}{}:
	default:
	}
	return err
}

func (b *forgetBook) pending() []PendingForget {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]PendingForget(nil), b.list...)
}

func (b *forgetBook) done(f PendingForget) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.list = slices.DeleteFunc(b.list, func(x PendingForget) bool { return x == f })
	delete(b.refused, f)
	b.saveLocked()
}

// markRefused records whether the service's last answer to f was 403.
func (b *forgetBook) markRefused(f PendingForget, refused bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.refused[f] == refused {
		return
	}
	if refused {
		b.refused[f] = true
	} else {
		delete(b.refused, f)
	}
	b.saveLocked()
}

func (b *forgetBook) refusedList() []PendingForget {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []PendingForget
	for _, f := range b.list {
		if b.refused[f] {
			out = append(out, f)
		}
	}
	return out
}

// answered reports a final reply: success, or a refusal that can never succeed (400 malformed,
// 404 gone, 409 conflict). Everything else is retried with the backoff: 400 "stale" (the ts was
// outside the service's window, so a later try with a fresh ts can pass), 401, 403 (the signing
// node not registered under that account yet), 429, 5xx and network errors.
func answered(err error) bool {
	if err == nil {
		return true
	}
	var h *login.HTTPError
	if !errors.As(err, &h) {
		return false
	}
	switch h.Status {
	case http.StatusBadRequest:
		return !strings.Contains(h.Body, `"stale"`)
	case http.StatusNotFound, http.StatusConflict:
		return true
	}
	return false
}

// forgetLoop sends queued forgets until the service answers each, backing off from 30 s to 1 h.
func (d *Daemon) forgetLoop(ctx context.Context) {
	wait := forgetFirstRetry
	for {
		left := 0
		for _, f := range d.forgets.pending() {
			fctx, cancel := context.WithTimeout(ctx, 30*time.Second)
			err := login.New(f.LoginURL).Forget(fctx, d.id, f.NodeID, d.now())
			cancel()
			final := answered(err)
			var h *login.HTTPError
			d.forgets.markRefused(f, errors.As(err, &h) && h.Status == http.StatusForbidden)
			if final {
				if err != nil {
					d.opt.Logf("login forget %s: %v", f.NodeID, err)
				}
				d.forgets.done(f)
			}
			if d.opt.OnForget != nil {
				d.opt.OnForget(f.NodeID, err, !final)
			}
			if final {
				continue
			}
			d.opt.Logf("login forget %s: %v; retrying", f.NodeID, err)
			left++
		}
		var retry <-chan time.Time
		if left > 0 {
			retry = d.retryAfter(wait)
			wait = min(wait*2, forgetMaxRetry)
		} else {
			wait = forgetFirstRetry
		}
		select {
		case <-ctx.Done():
			return
		case <-d.forgets.kick:
		case <-retry:
		}
	}
}

func (d *Daemon) retryAfter(t time.Duration) <-chan time.Time {
	if d.opt.RetryAfter != nil {
		return d.opt.RetryAfter(t)
	}
	return time.After(t)
}
