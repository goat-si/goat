package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/session"
	"github.com/goat-si/goat/apps/pen/internal/state"
	"github.com/goat-si/goat/apps/pen/internal/stream"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// peer is what dialing a member needs, read from the state directory (no daemon required).
type peer struct {
	id     *ident.Identity
	relays []string
	view   *mesh.View
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
	relays := cfg.RelayList()
	if env := envRelays(); len(env) > 0 {
		relays = env
	}
	return &peer{id: id, relays: relays, view: v}, nil
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

// openServiceErr explains a failed service stream to m.
func openServiceErr(err error, m mesh.Member, service string, confirmed bool) error {
	switch relay.CodeOf(err) {
	case wire.CodeNotAdmitted:
		if !confirmed {
			return fmt.Errorf("%s has Pen older than 1.2, or does not count this machine as a member (4401)", m.Name)
		}
	case wire.CodeOffline:
		if confirmed {
			return fmt.Errorf("%s has no program serving %s, or could not deliver to it (4404)", m.Name, service)
		}
	case wire.CodeCaps:
		return fmt.Errorf("%s is busy delivering other streams to %s (4429)", m.Name, service)
	}
	return openErr(err, m, 0, confirmed)
}

// RunPipe connects stdin/stdout to a TCP port on a member (for ssh ProxyCommand), or, in the exact form
// (--node and --noise), to a port or a registered service on exactly that node (contract "Services").
func RunPipe(args []string, stdout, stderr io.Writer) int {
	die := func(err error) int {
		fmt.Fprintln(stderr, "pen pipe:", err)
		return 255
	}
	fs := newFlags("pipe", stderr)
	home := fs.String("home", "", "state directory instead of PEN_HOME (ssh on Windows runs ProxyCommand without a shell)")
	node := fs.String("node", "", "exact node id, with --noise: no name or prefix lookup")
	noise := fs.String("noise", "", "the Noise key the --node member must have in this machine's view")
	// Flags come before the node only: ssh puts the host name into what follows, and a name that
	// arrives as several arguments (Win32-OpenSSH quotes nothing) must not be read as flags.
	if err := fs.Parse(args); err != nil {
		return 255
	}
	pos := fs.Args()
	exact := *node != "" || *noise != ""
	if exact && (*node == "" || *noise == "" || len(pos) != 1) {
		return die(errors.New("usage: pen pipe --node <nodeId> --noise <noisePub> (<port> | @<service>)"))
	}
	if !exact && len(pos) != 2 {
		return die(errors.New("usage: pen pipe <node> <port>"))
	}
	target := pos[len(pos)-1]
	var port int
	var err error
	service := ""
	if exact && strings.HasPrefix(target, "@") {
		service = target[1:]
		if !daemon.ValidServiceName(service) {
			return die(fmt.Errorf("bad service name %q", service))
		}
	} else if port, err = parsePort(target); err != nil {
		return die(err)
	}
	var st *state.Store
	if *home != "" {
		st, err = state.OpenDir(*home)
	} else {
		st, err = openState()
	}
	if err != nil {
		return die(err)
	}
	p, err := loadPeer(st)
	if err != nil {
		return die(err)
	}
	var m mesh.Member
	if exact {
		m, err = ResolveExact(p.view.SortedMembers(), *node, *noise)
	} else {
		m, err = Resolve(p.view.SortedMembers(), pos[0])
	}
	if err != nil {
		return die(err)
	}
	fail := func(err error, confirmed bool) error {
		if service != "" {
			return openServiceErr(err, m, service, confirmed)
		}
		return openErr(err, m, port, confirmed)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	revoked, stopWatch := daemon.WatchRevoked(st, m.NodeID)
	defer stopWatch()
	// The exact form writes nothing to stderr before its ready line, so it never traces.
	var tr *openTrace
	if !exact {
		tr = newOpenTrace(stderr, "")
	}
	var sec *session.Secure
	if service != "" {
		sec, err = daemon.OpenService(tr.context(ctx), p.relays, p.id, m, service)
	} else {
		sec, err = daemon.OpenTCP(tr.context(ctx), p.relays, p.id, m, port)
	}
	if err != nil {
		return die(fail(err, false))
	}
	if service != "" {
		// The ready line: the responder holds m's Noise key. Written before stdin is read.
		if _, err := fmt.Fprintf(stderr, "pen-ready v1 %s %s\n", m.NodeID, m.NoisePub); err != nil {
			sec.Close(wire.CodeNormal)
			return 255
		}
	}
	var wasRevoked atomic.Bool
	spliced := make(chan struct{})
	defer close(spliced)
	go func() {
		select {
		case <-revoked:
			wasRevoked.Store(true)
			sec.Close(wire.CodeNotAdmitted)
		case <-spliced:
		}
	}()
	closeOut := func() error {
		if c, ok := stdout.(io.Closer); ok {
			return c.Close()
		}
		return nil
	}
	if err := stream.Splice(ctx, tr.link(sec), Stdin, stdout, closeOut); err != nil {
		if wasRevoked.Load() {
			return die(revokedErr(m))
		}
		return die(fail(err, true))
	}
	return 0
}

func revokedErr(m mesh.Member) error {
	return fmt.Errorf("%s (%s) was revoked from the mesh; session closed", m.Name, short(m.NodeID))
}
