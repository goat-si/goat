package cli

import (
	"errors"
	"net"
	"syscall"
)

// localGone reports errors that only mean the local TCP client already went away.
func localGone(err error) bool {
	return errors.Is(err, syscall.ENOTCONN) || errors.Is(err, syscall.EPIPE) || errors.Is(err, syscall.ECONNRESET)
}

// errClientGone marks a localGone error from the local socket, so it is told apart from relay errors after Splice.
type errClientGone struct{ err error }

func (e *errClientGone) Error() string { return e.err.Error() }
func (e *errClientGone) Unwrap() error { return e.err }

func markGone(err error) error {
	if localGone(err) {
		return &errClientGone{err}
	}
	return err
}

// localConn is the forwarded client's socket with its errors marked.
type localConn struct{ c *net.TCPConn }

func (l localConn) Read(p []byte) (int, error) {
	n, err := l.c.Read(p)
	return n, markGone(err)
}

func (l localConn) Write(p []byte) (int, error) {
	n, err := l.c.Write(p)
	return n, markGone(err)
}

func (l localConn) CloseWrite() error { return markGone(l.c.CloseWrite()) }

func clientGone(err error) bool {
	var g *errClientGone
	return errors.As(err, &g)
}
