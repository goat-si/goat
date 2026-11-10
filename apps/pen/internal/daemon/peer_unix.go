//go:build unix

package daemon

import "net"

// peerIsOwner is true on unix: the socket's mode (0600) and its 0700 directory already keep other
// users out.
func peerIsOwner(net.Conn) bool { return true }
