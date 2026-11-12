package traffic

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/stream"
)

// benchSplice moves 4 MiB through stream.Splice over an in-memory relay pipe per iteration. With metered, the
// receiving end adds each DATA record to a Window, as the daemon does for the tcp sessions it accepts. The pipe does
// no encryption, so the meter's share here is larger than in a real session.
func benchSplice(b *testing.B, metered bool) {
	payload := make([]byte, 4<<20)
	w := NewWindow(time.Now)
	b.SetBytes(int64(len(payload)))
	b.ResetTimer()
	for range b.N {
		la, lb := relay.Pipe()
		var link stream.Link = lb
		if metered {
			link = Meter(lb, func(in, out uint64) { _ = w.Add("member", "relay", in, out) })
		}
		var wg sync.WaitGroup
		wg.Add(2)
		var errA, errB error
		go func() {
			defer wg.Done()
			errA = stream.Splice(context.Background(), la, bytes.NewReader(payload), io.Discard, nil)
		}()
		go func() {
			defer wg.Done()
			errB = stream.Splice(context.Background(), link, bytes.NewReader(nil), io.Discard, nil)
		}()
		wg.Wait()
		if errA != nil || errB != nil {
			b.Fatal(errA, errB)
		}
	}
}

func BenchmarkSplice(b *testing.B)        { benchSplice(b, false) }
func BenchmarkSpliceMetered(b *testing.B) { benchSplice(b, true) }

// BenchmarkWindowAddParallel is the shared window's lock under every available processor adding full DATA records.
func BenchmarkWindowAddParallel(b *testing.B) {
	w := NewWindow(time.Now)
	b.RunParallel(func(pb *testing.PB) {
		i := 0
		for pb.Next() {
			_ = w.Add(fmt.Sprint("member-", i%8), "relay", stream.MaxData, 0)
			i++
		}
	})
}
