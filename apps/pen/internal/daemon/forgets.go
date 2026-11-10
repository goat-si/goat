package daemon

import (
	"context"
	"errors"
	"net/http"
	"slices"
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

type forgetBook struct {
	st   *state.Store
	mu   sync.Mutex
	list []PendingForget
	kick chan struct{}
}

func loadForgets(st *state.Store) (*forgetBook, error) {
	b := &forgetBook{st: st, kick: make(chan struct{}, 1)}
	if _, err := st.ReadJSON(ForgetsFile, &b.list); err != nil {
		return nil, err
	}
	return b, nil
}

func (b *forgetBook) saveLocked() error {
	unlock, err := b.st.Lock()
	if err != nil {
		return err
	}
	defer unlock()
	list := b.list
	if list == nil {
		list = []PendingForget{}
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
	b.saveLocked()
}

// answered reports a final reply: success, or a refusal that can never succeed (400 malformed,
// 404 gone, 409 conflict). Everything else is retried with the backoff: 401 (clock skew, or the
// signing node not registered yet), 403, 429, 5xx and network errors.
func answered(err error) bool {
	if err == nil {
		return true
	}
	var h *login.HTTPError
	if !errors.As(err, &h) {
		return false
	}
	switch h.Status {
	case http.StatusBadRequest, http.StatusNotFound, http.StatusConflict:
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
