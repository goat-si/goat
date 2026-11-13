package daemon

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
)

// missedCloseConn is a holder connection whose reads follow a script. A step "timeout" stands for a read that saw
// nothing within its deadline. It needs a read deadline set since the previous timeout step; without one the read
// would block forever, as a read that missed the holder's close does on Windows, and the step fails at once with
// errNoDeadline. After the script every read returns EOF: this fake models a fresh read that sees the close, the
// outcome the recheck relies on.
type missedCloseConn struct {
	mu     sync.Mutex
	script []string
	armed  bool
	wrote  bytes.Buffer
}

var errNoDeadline = errors.New("a read with no deadline would block forever")

func newMissedCloseConn(script ...string) *missedCloseConn {
	return &missedCloseConn{script: script}
}

func (c *missedCloseConn) Read(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.script) == 0 {
		return 0, io.EOF
	}
	step := c.script[0]
	c.script = c.script[1:]
	if step != "timeout" {
		return copy(p, step), nil
	}
	if !c.armed {
		return 0, &net.OpError{Op: "read", Net: "unix", Err: errNoDeadline}
	}
	c.armed = false
	return 0, &net.OpError{Op: "read", Net: "unix", Err: os.ErrDeadlineExceeded}
}

func (c *missedCloseConn) SetReadDeadline(t time.Time) error {
	c.mu.Lock()
	c.armed = !t.IsZero()
	c.mu.Unlock()
	return nil
}

func (c *missedCloseConn) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.wrote.Write(p)
}

func (c *missedCloseConn) written() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.wrote.String()
}

func (c *missedCloseConn) Close() error                     { return nil }
func (c *missedCloseConn) CloseWrite() error                { return nil }
func (c *missedCloseConn) LocalAddr() net.Addr              { return &net.UnixAddr{Net: "unix"} }
func (c *missedCloseConn) RemoteAddr() net.Addr             { return &net.UnixAddr{Net: "unix"} }
func (c *missedCloseConn) SetDeadline(t time.Time) error    { return c.SetReadDeadline(t) }
func (c *missedCloseConn) SetWriteDeadline(time.Time) error { return nil }

// A read of a registration's ops on Windows may miss the holder's half-close and its close. The node then reads the
// ops again after each holderRecheck: a registration whose holder is gone ends, and one that is only idle keeps
// reading, with a line that spans a recheck read whole.
func TestARegistrationWhoseHolderIsGoneEndsAndAnIdleOneKeepsReading(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a, ended := startEnding(t, ctx, rs)
	c := newMissedCloseConn(
		"timeout", // idle
		`{"op":"service.clients",`,
		"timeout", // idle in the middle of a line
		`"gen":1,"clients":[]}`+"\n",
		"timeout", // the holder is gone and this read missed its close
	)
	lr := &io.LimitedReader{R: c, N: 64 << 10}
	req := Request{Op: "service.register", Name: "goat", Port: 1, Key: ident.B64.EncodeToString(newKey(t))}
	done := make(chan bool, 1)
	go func() {
		done <- a.d.controlRegister(ctx, c, bufio.NewReader(lr), lr, req, func(any) {}, func(err error) { t.Errorf("refused: %v", err) })
	}()
	if owned := <-done; !owned {
		t.Fatal("the registration did not take the connection")
	}
	<-ended
	if w := c.written(); !strings.Contains(w, `"t":"clients"`) {
		t.Fatalf("the holder got %q; want the answer to the op that spanned a recheck", w)
	}
}
