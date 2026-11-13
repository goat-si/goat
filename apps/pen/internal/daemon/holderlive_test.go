package daemon

import (
	"bufio"
	"bytes"
	"context"
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
// nothing within its deadline: it waits until the reader sets a read deadline (a read without one blocks, as a read
// that missed the holder's close does on Windows) and then returns a timeout. After the script every read returns EOF,
// as a fresh read of a closed connection does.
type missedCloseConn struct {
	mu      sync.Mutex
	script  []string
	armed   chan struct{}
	armOnce sync.Once
	closed  chan struct{}
	closeMu sync.Once
	wrote   bytes.Buffer
}

func newMissedCloseConn(script ...string) *missedCloseConn {
	return &missedCloseConn{script: script, armed: make(chan struct{}), closed: make(chan struct{})}
}

func (c *missedCloseConn) Read(p []byte) (int, error) {
	c.mu.Lock()
	if len(c.script) == 0 {
		c.mu.Unlock()
		return 0, io.EOF
	}
	step := c.script[0]
	c.script = c.script[1:]
	c.mu.Unlock()
	if step != "timeout" {
		return copy(p, step), nil
	}
	select {
	case <-c.armed:
		// Each timeout needs the reader to arm again before the next one.
		c.mu.Lock()
		c.armed, c.armOnce = make(chan struct{}), sync.Once{}
		c.mu.Unlock()
		return 0, &net.OpError{Op: "read", Net: "unix", Err: os.ErrDeadlineExceeded}
	case <-c.closed:
		return 0, net.ErrClosed
	}
}

func (c *missedCloseConn) SetReadDeadline(t time.Time) error {
	if !t.IsZero() {
		c.mu.Lock()
		armed, once := c.armed, &c.armOnce
		c.mu.Unlock()
		once.Do(func() { close(armed) })
	}
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

func (c *missedCloseConn) Close() error                     { c.closeMu.Do(func() { close(c.closed) }); return nil }
func (c *missedCloseConn) CloseWrite() error                { return nil }
func (c *missedCloseConn) LocalAddr() net.Addr              { return &net.UnixAddr{Net: "unix"} }
func (c *missedCloseConn) RemoteAddr() net.Addr             { return &net.UnixAddr{Net: "unix"} }
func (c *missedCloseConn) SetDeadline(t time.Time) error    { return c.SetReadDeadline(t) }
func (c *missedCloseConn) SetWriteDeadline(time.Time) error { return nil }

// A read of a registration's ops on Windows can miss the holder's half-close and its close. The node then reads the
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
