package stream_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"io"
	"sync"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/stream"
)

// meter wraps a link and checks the window invariant on every DATA it sends.
type meter struct {
	relay.Conn
	t *testing.T

	mu       sync.Mutex
	sent     int
	credited int
	maxOut   int
	filled   chan struct{}
	once     sync.Once
}

func (m *meter) Send(p []byte) error {
	if len(p) > 0 && p[0] == stream.TypeData {
		m.mu.Lock()
		m.sent += len(p) - 1
		out := m.sent - m.credited
		m.maxOut = max(m.maxOut, out)
		m.mu.Unlock()
		if out > stream.Window {
			m.t.Errorf("in flight %d > window", out)
		}
		if out >= stream.Window-stream.MaxData {
			m.once.Do(func() { close(m.filled) })
		}
	}
	return m.Conn.Send(p)
}

func (m *meter) Recv(ctx context.Context) ([]byte, error) {
	p, err := m.Conn.Recv(ctx)
	if err == nil && len(p) == 5 && p[0] == stream.TypeCredit {
		m.mu.Lock()
		m.credited += int(binary.LittleEndian.Uint32(p[1:]))
		m.mu.Unlock()
	}
	return p, err
}

// gated blocks its first Write until open is closed; started, when set, is closed as that Write begins.
type gated struct {
	open    <-chan struct{}
	started chan struct{}
	once    sync.Once
	buf     bytes.Buffer
}

func (g *gated) Write(p []byte) (int, error) {
	if g.started != nil {
		g.once.Do(func() { close(g.started) })
	}
	<-g.open
	return g.buf.Write(p)
}

func TestStalledReaderCapsInFlightAtWindowAnd8MiBArrivesIntact(t *testing.T) {
	ctx := context.Background()
	a, b := relay.Pipe()
	m := &meter{Conn: a, t: t, filled: make(chan struct{})}
	src := make([]byte, 8<<20)
	rand.Read(src)
	out := &gated{open: m.filled}
	errs := make(chan error, 2)
	go func() { errs <- stream.Splice(ctx, m, bytes.NewReader(src), io.Discard, nil) }()
	go func() { errs <- stream.Splice(ctx, b, bytes.NewReader(nil), out, nil) }()
	for range 2 {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	if !bytes.Equal(out.buf.Bytes(), src) {
		t.Fatal("bytes differ")
	}
	if m.maxOut > stream.Window || m.maxOut < stream.Window-stream.MaxData {
		t.Fatalf("max in flight %d, want just under the %d window", m.maxOut, stream.Window)
	}
}

func TestEchoPeerDoesNotDeadlockWhileItsWriterIsBlocked(t *testing.T) {
	ctx := context.Background()
	a, b := relay.Pipe()
	src := make([]byte, 4<<20)
	rand.Read(src)
	// b's side is an echo server: what it writes comes back out of its reader.
	pr, pw := io.Pipe()
	var got bytes.Buffer
	errs := make(chan error, 2)
	go func() { errs <- stream.Splice(ctx, a, bytes.NewReader(src), &got, nil) }()
	go func() { errs <- stream.Splice(ctx, b, pr, pw, pw.Close) }()
	for range 2 {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	if !bytes.Equal(got.Bytes(), src) {
		t.Fatal("echo differs")
	}
}

func TestFinHalfClosesAndTheOtherDirectionKeepsFlowing(t *testing.T) {
	ctx := context.Background()
	a, b := relay.Pipe()
	halfClosed := make(chan struct{})
	pr, pw := io.Pipe()
	var atA, atB bytes.Buffer
	errs := make(chan error, 2)
	go func() { errs <- stream.Splice(ctx, a, bytes.NewReader([]byte("request")), &atA, nil) }()
	go func() {
		errs <- stream.Splice(ctx, b, pr, &atB, func() error { close(halfClosed); return nil })
	}()
	<-halfClosed
	if atB.String() != "request" {
		t.Fatalf("b got %q before FIN", atB.String())
	}
	pw.Write([]byte("response after FIN"))
	pw.Close()
	for range 2 {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	if atA.String() != "response after FIN" {
		t.Fatalf("a got %q", atA.String())
	}
}

func TestDataPastTheWindowCloses4408(t *testing.T) {
	ctx := context.Background()
	a, b := relay.Pipe()
	rec := append([]byte{stream.TypeData}, make([]byte, stream.MaxData)...)
	for range stream.Window/stream.MaxData + 1 {
		a.Send(rec)
	}
	err := stream.Splice(ctx, b, bytes.NewReader(nil), &gated{open: make(chan struct{})}, nil)
	if relay.CodeOf(err) != 4408 {
		t.Fatalf("got %v, want 4408", err)
	}
	for {
		if _, err := a.Recv(ctx); err != nil {
			if relay.CodeOf(err) != 4408 {
				t.Fatalf("peer saw %v, want 4408", err)
			}
			break
		}
	}
}

func TestALinkCutAfterThePeersFinWasWrittenOutIsDelivered(t *testing.T) {
	a, b := relay.Pipe()
	pr, pw := io.Pipe() // this side never ends its own direction
	defer pw.Close()
	var got bytes.Buffer
	halfClosed := make(chan struct{})
	errc := make(chan error, 1)
	go func() {
		errc <- stream.Splice(context.Background(), b, pr, &got, func() error { close(halfClosed); return nil })
	}()
	a.Send(append([]byte{stream.TypeData}, "reply"...))
	a.Send([]byte{stream.TypeFin})
	<-halfClosed
	a.Close(4404)
	err := <-errc
	if relay.CodeOf(err) != 4404 || !stream.Delivered(err) {
		t.Fatalf("got %v, delivered %v; want 4404 and delivered, the peer's whole stream was written", err, stream.Delivered(err))
	}
	if got.String() != "reply" {
		t.Fatalf("wrote %q", got.String())
	}
}

// creditHeld holds the first CREDIT this side sends until release is closed, after its writes to w returned.
type creditHeld struct {
	relay.Conn
	held    chan struct{}
	release chan struct{}
	once    sync.Once
}

func (c *creditHeld) Send(p []byte) error {
	if len(p) > 0 && p[0] == stream.TypeCredit {
		c.once.Do(func() { close(c.held) })
		<-c.release
	}
	return c.Conn.Send(p)
}

func TestALinkCutAfterThePeersFinIsDeliveredWhileTheWriterIsStillCreditingWhatItWrote(t *testing.T) {
	a, b := relay.Pipe()
	link := &creditHeld{Conn: b, held: make(chan struct{}), release: make(chan struct{})}
	pr, pw := io.Pipe()
	defer pw.Close()
	var got bytes.Buffer
	errc := make(chan error, 1)
	go func() { errc <- stream.Splice(context.Background(), link, pr, &got, nil) }()
	reply := make([]byte, stream.CreditEvery)
	rand.Read(reply)
	a.Send(append([]byte{stream.TypeData}, reply[:stream.MaxData]...))
	a.Send(append([]byte{stream.TypeData}, reply[stream.MaxData:]...))
	<-link.held // every byte reached w; the writer is sending its CREDIT
	a.Send([]byte{stream.TypeFin})
	a.Close(4404)
	err := <-errc
	close(link.release)
	if relay.CodeOf(err) != 4404 || !stream.Delivered(err) {
		t.Fatalf("got %v, delivered %v; want 4404 and delivered, the peer's whole stream was written", err, stream.Delivered(err))
	}
	if !bytes.Equal(got.Bytes(), reply) {
		t.Fatalf("wrote %d bytes, want the %d the peer sent", got.Len(), len(reply))
	}
}

func TestALinkCutAfterThePeersFinButBeforeItsDataWasWrittenOutIsNotDelivered(t *testing.T) {
	a, b := relay.Pipe()
	pr, pw := io.Pipe()
	defer pw.Close()
	open := make(chan struct{})
	defer close(open) // releases the writer still holding the peer's DATA
	w := &gated{open: open, started: make(chan struct{})}
	errc := make(chan error, 1)
	go func() { errc <- stream.Splice(context.Background(), b, pr, w, nil) }()
	a.Send(append([]byte{stream.TypeData}, "reply"...))
	<-w.started // the writer took the DATA off its queue and is inside Write
	a.Send([]byte{stream.TypeFin})
	a.Close(4404)
	err := <-errc
	if relay.CodeOf(err) != 4404 || stream.Delivered(err) {
		t.Fatalf("got %v, delivered %v; want 4404 and not delivered, the peer's DATA was never written", err, stream.Delivered(err))
	}
}
