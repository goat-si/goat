package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/session"
	"github.com/goat-si/goat/apps/pen/internal/stream"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// RunForward listens on 127.0.0.1:<localPort> and opens one session per connection to node:port.
func RunForward(args []string, stdout, stderr io.Writer) int {
	pos, err := parse(newFlags("forward", stderr), args)
	if err != nil {
		return 2
	}
	if len(pos) != 2 {
		fmt.Fprintln(stderr, "usage: pen forward <localPort> <node>:<port>")
		return 2
	}
	local, err := parsePort(pos[0])
	if err != nil {
		return fail(stderr, err)
	}
	i := strings.LastIndexByte(pos[1], ':')
	if i < 0 {
		return fail(stderr, errors.New("target must be <node>:<port>"))
	}
	port, err := parsePort(pos[1][i+1:])
	if err != nil {
		return fail(stderr, err)
	}
	st, err := openState()
	if err != nil {
		return fail(stderr, err)
	}
	p, err := loadPeer(st)
	if err != nil {
		return fail(stderr, err)
	}
	m, err := Resolve(p.view.SortedMembers(), pos[1][:i])
	if err != nil {
		return fail(stderr, err)
	}
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(local)))
	if err != nil {
		return fail(stderr, err)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	revoked, stopWatch := daemon.WatchRevoked(st, m.NodeID)
	defer stopWatch()
	var mu sync.Mutex
	open := map[*session.Secure]bool{}
	var wasRevoked atomic.Bool
	go func() {
		select {
		case <-revoked:
			wasRevoked.Store(true)
			mu.Lock()
			for sec := range open {
				sec.Close(wire.CodeNotAdmitted)
			}
			mu.Unlock()
			cancel()
		case <-ctx.Done():
		}
		ln.Close()
	}()
	fmt.Fprintf(stdout, "forwarding %s -> %s:%d (Ctrl-C stops)\n", ln.Addr(), m.Name, port)
	for {
		c, err := ln.Accept()
		if err != nil {
			if wasRevoked.Load() {
				fmt.Fprintln(stderr, "pen forward:", revokedErr(m))
				return 255
			}
			if ctx.Err() != nil {
				return 0
			}
			return fail(stderr, err)
		}
		go func() {
			tc := c.(*net.TCPConn)
			defer tc.Close()
			sec, err := daemon.OpenTCP(ctx, p.relay, p.id, m, port)
			if err != nil {
				fmt.Fprintln(stderr, "pen forward:", openErr(err, m, port, false))
				return
			}
			mu.Lock()
			if wasRevoked.Load() {
				mu.Unlock()
				sec.Close(wire.CodeNotAdmitted)
				return
			}
			open[sec] = true
			mu.Unlock()
			defer func() {
				mu.Lock()
				delete(open, sec)
				mu.Unlock()
			}()
			if err := stream.Splice(ctx, sec, tc, tc, tc.CloseWrite); err != nil && !wasRevoked.Load() {
				fmt.Fprintln(stderr, "pen forward:", openErr(err, m, port, true))
			}
		}()
	}
}
