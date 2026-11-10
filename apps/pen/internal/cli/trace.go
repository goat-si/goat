package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/stream"
)

// envRelays is PEN_RELAYS (space-separated URLs), which replaces the configured relays for pipe
// and forward so a measurement can pin one path.
func envRelays() []string { return strings.Fields(os.Getenv("PEN_RELAYS")) }

// openTrace is one session open traced to stderr with PEN_TRACE=1: one line per stage of the
// relay race, then the first record from the member. Without PEN_TRACE it changes nothing.
type openTrace struct {
	w      io.Writer
	label  string
	start  time.Time
	winner string
}

var traceMu sync.Mutex

func newOpenTrace(stderr io.Writer, label string) *openTrace {
	if os.Getenv("PEN_TRACE") != "1" {
		return nil
	}
	return &openTrace{w: stderr, label: label, start: time.Now()}
}

func (t *openTrace) line(event, relayURL string) {
	traceMu.Lock()
	defer traceMu.Unlock()
	if event == "winner" {
		t.winner = relayURL
	}
	fmt.Fprintf(t.w, "pen trace:%s +%dms relay=%s %s\n", t.label, time.Since(t.start).Milliseconds(), relayURL, event)
}

// context carries the trace into the relay race.
func (t *openTrace) context(ctx context.Context) context.Context {
	if t == nil {
		return ctx
	}
	return relay.WithTrace(ctx, func(event, relayURL string, _ time.Duration) { t.line(event, relayURL) })
}

// link reports the first record the member sends on l.
func (t *openTrace) link(l stream.Link) stream.Link {
	if t == nil {
		return l
	}
	return &firstRecord{Link: l, t: t}
}

type firstRecord struct {
	stream.Link
	t    *openTrace
	once sync.Once
}

func (f *firstRecord) Recv(ctx context.Context) ([]byte, error) {
	p, err := f.Link.Recv(ctx)
	if err == nil {
		f.once.Do(func() {
			traceMu.Lock()
			winner := f.t.winner
			traceMu.Unlock()
			f.t.line("first-byte", winner)
		})
	}
	return p, err
}
