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
	"syscall"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/stream"
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
	go func() {
		<-ctx.Done()
		ln.Close()
	}()
	fmt.Fprintf(stdout, "forwarding %s -> %s:%d (Ctrl-C stops)\n", ln.Addr(), m.Name, port)
	for {
		c, err := ln.Accept()
		if err != nil {
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
			if err := stream.Splice(ctx, sec, tc, tc, tc.CloseWrite); err != nil {
				fmt.Fprintln(stderr, "pen forward:", openErr(err, m, port, true))
			}
		}()
	}
}
