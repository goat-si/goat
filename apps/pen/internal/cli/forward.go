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
	"time"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/session"
	"github.com/goat-si/goat/apps/pen/internal/state"
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
	return runForward(ctx, ln, st, p, m, port, stdout, stderr, nil)
}

// runForward serves ln until ctx ends, or m or this node is revoked (pen leave revokes this node);
// connDone (may be nil) runs after each connection's last output.
func runForward(ctx context.Context, ln net.Listener, st *state.Store, p *peer, m mesh.Member, port int, stdout, stderr io.Writer, connDone func()) int {
	// A forward that is stopping ends its connections itself (ctx is done): none of them reports that as an error.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	// Each connection sends its last traffic report as it ends: wait for them before returning (and exiting),
	// cancelling first so they end.
	var conns sync.WaitGroup
	defer waitConns(&conns)
	defer cancel()
	self := p.id.NodeID()
	revoked, stopWatch, err := watchRevoked(st, p, m)
	if err != nil {
		ln.Close()
		return fail(stderr, err)
	}
	defer stopWatch()
	var mu sync.Mutex
	open := map[*session.Secure]bool{}
	var wasRevoked atomic.Bool
	var revokedErr error
	go func() {
		select {
		case who := <-revoked:
			mu.Lock()
			revokedErr = revokedNodeErr(m, who == self)
			wasRevoked.Store(true)
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
	for n := 1; ; n++ {
		c, err := ln.Accept()
		if err != nil {
			if wasRevoked.Load() {
				mu.Lock()
				fmt.Fprintln(stderr, "pen forward:", revokedErr)
				mu.Unlock()
				return 255
			}
			if ctx.Err() != nil {
				return 0
			}
			return fail(stderr, err)
		}
		conns.Add(1)
		go func() {
			defer conns.Done()
			if connDone != nil {
				defer connDone()
			}
			tc := c.(*net.TCPConn)
			defer tc.Close()
			tr := newOpenTrace(stderr, fmt.Sprintf(" conn=%d", n))
			sec, used, err := daemon.OpenTCPVia(tr.context(ctx), p.relays, p.id, m, port)
			if err != nil {
				if ctx.Err() == nil {
					fmt.Fprintln(stderr, "pen forward:", openErr(err, m, port, false))
				}
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
			lc := localConn{tc}
			counted := startTraffic(st, m.NodeID, used)
			if err := stream.Splice(ctx, counted.link(tr.link(sec)), lc, lc, lc.CloseWrite); err != nil {
				if !stream.Delivered(err) {
					// The peer's stream stopped short of its FIN: the client reads a reset, not a clean end.
					tc.SetLinger(0)
				}
				if !wasRevoked.Load() && !clientGone(err) && ctx.Err() == nil {
					fmt.Fprintln(stderr, "pen forward:", openErr(err, m, port, true))
				}
			}
			// The local client sees its end before the last report goes out.
			tc.Close()
			counted.finish()
		}()
	}
}

// forwardDrain bounds how long a stopping forward waits for its connections' last reports.
const forwardDrain = 3 * time.Second

func waitConns(conns *sync.WaitGroup) {
	done := make(chan struct{})
	go func() {
		conns.Wait()
		close(done)
	}()
	t := time.NewTimer(forwardDrain)
	defer t.Stop()
	select {
	case <-done:
	case <-t.C:
	}
}
