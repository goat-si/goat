package daemon

import (
	"errors"
	"net"
	"testing"
)

// A request CallWithin could not send is told apart from one sent but not answered in time: only the
// second may still be acted on by the daemon.
func TestCallWithinSaysWhetherTheRequestWentOut(t *testing.T) {
	st := shortDir(t)
	l, err := net.Listen("unix", SocketPath(st))
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			defer c.Close() // takes the connection, reads nothing, answers nothing
		}
	}()
	old := sendTimeout
	t.Cleanup(func() { sendTimeout = old })
	sendTimeout = 0 // the write deadline has passed before the request is written
	err = CallWithin(st, Request{Op: "leave"}, &struct{}{}, 0)
	if !errors.Is(err, ErrNotSent) {
		t.Fatalf("unsent request: %v, want ErrNotSent", err)
	}
	sendTimeout = old
	err = CallWithin(st, Request{Op: "leave"}, &struct{}{}, 0)
	var ne net.Error
	if errors.Is(err, ErrNotSent) || !errors.As(err, &ne) || !ne.Timeout() {
		t.Fatalf("sent but unanswered request: %v, want a read timeout", err)
	}
}
