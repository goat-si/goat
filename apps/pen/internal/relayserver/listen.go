package relayserver

import (
	"net"
	"sync"
)

// SocketBuffer is the kernel send and receive buffer each accepted connection gets (Linux doubles
// it for bookkeeping). A fixed size bounds what the kernel holds per connection, which counts
// toward a cgroup's memory limit; autotuning would let a client that stops reading hold megabytes.
// It caps one session's throughput near 2*SocketBuffer per round trip.
const SocketBuffer = 64 << 10

// MaxHeaderBytes caps a request's headers; relay requests are a few hundred bytes.
const MaxHeaderBytes = 8 << 10

// Listen caps the connections ln hands out at MaxSockets in all and MaxPerIP per source, counting
// them from accept, before any request is read: a connection still sending its headers or its TLS
// handshake holds memory too. One past a cap is closed at once.
func (s *Server) Listen(ln net.Listener) net.Listener {
	return &capListener{Listener: ln, srv: s, perIP: map[string]int{}}
}

type capListener struct {
	net.Listener
	srv   *Server
	mu    sync.Mutex
	total int
	perIP map[string]int
}

func (l *capListener) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		key := sourceKey(c.RemoteAddr().String())
		l.mu.Lock()
		full := l.total >= orDefault(l.srv.MaxSockets, DefaultMaxSockets) ||
			l.perIP[key] >= orDefault(l.srv.MaxPerIP, DefaultMaxPerIP)
		if !full {
			l.total++
			l.perIP[key]++
		}
		l.mu.Unlock()
		if full {
			c.Close()
			continue
		}
		if tc, ok := c.(*net.TCPConn); ok {
			tc.SetReadBuffer(SocketBuffer)
			tc.SetWriteBuffer(SocketBuffer)
		}
		return &capConn{Conn: c, l: l, key: key}, nil
	}
}

type capConn struct {
	net.Conn
	l    *capListener
	key  string
	once sync.Once
}

func (c *capConn) Close() error {
	c.once.Do(func() {
		c.l.mu.Lock()
		c.l.total--
		if c.l.perIP[c.key]--; c.l.perIP[c.key] == 0 {
			delete(c.l.perIP, c.key)
		}
		c.l.mu.Unlock()
	})
	return c.Conn.Close()
}
