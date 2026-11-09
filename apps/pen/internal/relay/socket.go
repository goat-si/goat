package relay

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// PingInterval is the keepalive period for uplink and client sockets.
const PingInterval = 30 * time.Second

func dialWS(ctx context.Context, wsURL string) (*websocket.Conn, error) {
	c, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return nil, err
	}
	c.SetReadLimit(wire.MaxMessage + 64)
	return c, nil
}

// acker counts received relay bytes on arrival and acks every AckEvery bytes.
type acker struct {
	total, last uint64
}

func (a *acker) add(n int) (string, bool) {
	a.total += uint64(n)
	if a.total-a.last >= wire.AckEvery {
		a.last = a.total
		return wire.FormatAck(a.total), true
	}
	return "", false
}

func pinger(ctx context.Context, c *websocket.Conn) {
	t := time.NewTicker(PingInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := c.Write(ctx, websocket.MessageText, []byte("ping")); err != nil {
				return
			}
		}
	}
}

// statusCode maps a websocket read error to a close code (1006 when the socket dropped).
func statusCode(err error) uint16 {
	if s := websocket.CloseStatus(err); s != -1 {
		return uint16(s)
	}
	return 1006
}

// Dial opens a client socket to nodeID through the relay.
func Dial(ctx context.Context, relayURL, nodeID string) (Conn, error) {
	u, err := wire.WebSocketURL(relayURL, "/v1/client/"+nodeID)
	if err != nil {
		return nil, err
	}
	ws, err := dialWS(ctx, u)
	if err != nil {
		return nil, err
	}
	lctx, cancel := context.WithCancel(context.Background())
	c := &clientConn{ws: ws, in: newInbox(), ctx: lctx, cancel: cancel, done: make(chan struct{})}
	go c.readLoop()
	go pinger(lctx, ws)
	return c, nil
}

type clientConn struct {
	ws     *websocket.Conn
	in     *inbox
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}

	mu     sync.Mutex
	closed bool
}

func (c *clientConn) readLoop() {
	defer close(c.done)
	defer c.cancel()
	var ack acker
	for {
		typ, p, err := c.ws.Read(c.ctx)
		if err != nil {
			c.in.fail(&CloseError{Code: statusCode(err)})
			return
		}
		if typ != websocket.MessageBinary {
			continue
		}
		if s, ok := ack.add(len(p)); ok {
			if err := c.ws.Write(c.ctx, websocket.MessageText, []byte(s)); err != nil {
				c.in.fail(&CloseError{Code: 1006})
				return
			}
		}
		if !c.in.push(p) {
			go c.Close(wire.CodeTimeout)
			c.in.drop(&CloseError{Code: wire.CodeTimeout})
			return
		}
	}
}

func (c *clientConn) Send(p []byte) error {
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if closed {
		return ErrClosed
	}
	if err := c.ws.Write(c.ctx, websocket.MessageBinary, p); err != nil {
		// The socket is gone; report the close code its reader received (4404 from a relay
		// with no uplink for this node, for example) rather than a generic failure.
		select {
		case <-c.done:
		case <-time.After(time.Second):
		}
		if ce, ok := c.in.terminal().(*CloseError); ok {
			return ce
		}
		return &CloseError{Code: 1006}
	}
	return nil
}

func (c *clientConn) Recv(ctx context.Context) ([]byte, error) { return c.in.recv(ctx) }

func (c *clientConn) SetQueueLimit(n int) { c.in.setLimit(n) }

// Close sends a close frame with code and waits (bounded) for the socket to finish.
func (c *clientConn) Close(code uint16) error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	c.mu.Unlock()
	c.in.drop(ErrClosed)
	err := c.ws.Close(websocket.StatusCode(code), "")
	c.cancel()
	<-c.done
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return nil
}
