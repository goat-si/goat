package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/state"
	"github.com/goat-si/goat/apps/pen/internal/stream"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// peer is what dialing a member needs, read from the state directory (no daemon required).
type peer struct {
	id    *ident.Identity
	relay string
	view  *mesh.View
}

func loadPeer(st *state.Store) (*peer, error) {
	id, err := st.LoadIdentity()
	if errors.Is(err, os.ErrNotExist) {
		return nil, daemon.ErrNoIdentity
	}
	if err != nil {
		return nil, err
	}
	cfg, err := st.LoadConfig()
	if err != nil {
		return nil, err
	}
	v, err := localView(st)
	if err != nil {
		return nil, err
	}
	return &peer{id: id, relay: cfg.Relay, view: v}, nil
}

func parsePort(s string) (int, error) {
	p, err := strconv.Atoi(s)
	if err != nil || p < 1 || p > 65535 {
		return 0, fmt.Errorf("bad port %q", s)
	}
	return p, nil
}

func openErr(err error, m mesh.Member, port int, confirmed bool) error {
	switch relay.CodeOf(err) {
	case wire.CodeOffline:
		if confirmed {
			return fmt.Errorf("%s refused port %d", m.Name, port)
		}
		return fmt.Errorf("%s is offline", m.Name)
	case wire.CodeNotAdmitted:
		return fmt.Errorf("%s did not admit this node (is it still a member?)", m.Name)
	case wire.CodeCrypto:
		return fmt.Errorf("handshake with %s failed (4400)", m.Name)
	case wire.CodeTimeout:
		return fmt.Errorf("%s timed out", m.Name)
	}
	return err
}

// RunPipe connects stdin/stdout to a TCP port on a member (for ssh ProxyCommand).
func RunPipe(args []string, stdout, stderr io.Writer) int {
	die := func(err error) int {
		fmt.Fprintln(stderr, "pen pipe:", err)
		return 255
	}
	pos, err := parse(newFlags("pipe", stderr), args)
	if err != nil {
		return 255
	}
	if len(pos) != 2 {
		return die(errors.New("usage: pen pipe <node> <port>"))
	}
	port, err := parsePort(pos[1])
	if err != nil {
		return die(err)
	}
	st, err := openState()
	if err != nil {
		return die(err)
	}
	p, err := loadPeer(st)
	if err != nil {
		return die(err)
	}
	m, err := Resolve(p.view.SortedMembers(), pos[0])
	if err != nil {
		return die(err)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	sec, err := daemon.OpenTCP(ctx, p.relay, p.id, m, port)
	if err != nil {
		return die(openErr(err, m, port, false))
	}
	closeOut := func() error {
		if c, ok := stdout.(io.Closer); ok {
			return c.Close()
		}
		return nil
	}
	if err := stream.Splice(ctx, sec, Stdin, stdout, closeOut); err != nil {
		return die(openErr(err, m, port, true))
	}
	return 0
}
