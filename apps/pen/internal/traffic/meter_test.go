package traffic

import (
	"context"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/stream"
)

// heldLink's Send blocks until release closes; Recv is never called.
type heldLink struct {
	entered, release chan struct{}
}

func (l *heldLink) Send(p []byte) error {
	close(l.entered)
	<-l.release
	return nil
}
func (l *heldLink) Recv(ctx context.Context) ([]byte, error) { <-ctx.Done(); return nil, ctx.Err() }
func (l *heldLink) Close(uint16) error                       { return nil }

// A session that ends while its last DATA send is still returning must still count that send in its final report.
func TestSettleWaitsForASendStillInFlight(t *testing.T) {
	l := &heldLink{entered: make(chan struct{}), release: make(chan struct{})}
	var out uint64
	m := Meter(l, func(_, o uint64) { out += o })
	sent := make(chan error, 1)
	go func() { sent <- m.Send(append([]byte{stream.TypeData}, make([]byte, 10)...)) }()
	<-l.entered
	old := settleWaiting
	settleWaiting = func() { close(l.release) }
	defer func() { settleWaiting = old }()
	m.Settle(context.Background())
	if out != 10 {
		t.Fatalf("counted %d bytes out after Settle, want the 10 the send in flight carried", out)
	}
	if err := <-sent; err != nil {
		t.Fatal(err)
	}
}
