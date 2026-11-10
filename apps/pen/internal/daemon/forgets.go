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

// answered reports a reply the service gave on purpose; network errors, 429 and 5xx are retried.
func answered(err error) bool {
	if err == nil {
		return true
	}
	var h *login.HTTPError
	return errors.As(err, &h) && h.Status < 500 && h.Status != http.StatusTooManyRequests
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
			if answered(err) {
				if err != nil {
					d.opt.Logf("login forget %s: %v", f.NodeID, err)
				}
				d.forgets.done(f)
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
