package daemon

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
)

// drainingHolder registers "goat" twice on a and returns the first holder once its registration ended: it read
// "replaced" and the half-close, and never closes its side, so the node is draining it.
func drainingHolder(t *testing.T, a *node, ended <-chan string) (draining, active *holder) {
	t.Helper()
	draining = register(t, a, "goat", 1, newKey(t))
	active = register(t, a, "goat", 1, newKey(t))
	if m, ok := draining.next(t); !ok || m["t"] != "replaced" {
		t.Fatalf("the first holder got %v, %v; want replaced", m, ok)
	}
	if _, err := draining.r.ReadBytes('\n'); !errors.Is(err, io.EOF) {
		t.Fatalf("the first holder after replaced: %v, want the half-close", err)
	}
	if got := <-ended; got != draining.reply["id"] {
		t.Fatalf("ended %q, want %v", got, draining.reply["id"])
	}
	return draining, active
}

func startEnding(t *testing.T, ctx context.Context, rs *relaytest.Server) (*node, chan string) {
	t.Helper()
	ended := make(chan string, 4)
	st := shortDir(t)
	id := identity(t, st, rs.URL, "a")
	if _, err := mesh.Found(st, id, "a", 1); err != nil {
		t.Fatal(err)
	}
	return startWith(t, ctx, rs, st, func(o *Options) { o.ServiceEnded = func(id string) { ended <- id } }), ended
}

func rawDial(t *testing.T, n *node) net.Conn {
	t.Helper()
	c, err := net.Dial("unix", SocketPath(n.st))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

// holdDrains keeps every drain open until its holder closes or the daemon stops, so no deadline ends one in a test.
func holdDrains(t *testing.T) {
	was := holderDrainTime
	holderDrainTime = time.Hour
	t.Cleanup(func() { holderDrainTime = was })
}

func TestADrainingHolderKeepsItsControlSlotSoTheCapBoundsOpenControlConnections(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	holdDrains(t)
	was, wait := controlConnCap, controlRequestTimeout
	controlConnCap, controlRequestTimeout = 2, time.Hour // only the cap may close a connection here
	defer func() { controlConnCap, controlRequestTimeout = was, wait }()
	a, ended := startEnding(t, ctx, rs)
	drainingHolder(t, a, ended) // one ended registration draining, one active: the cap of 2 is reached
	extra := rawDial(t, a)
	extra.Write([]byte(`{"op":"status"}` + "\n"))
	// A refused connection ends with EOF or a reset, either an error; only a served one gets a line.
	if line, err := bufio.NewReader(extra).ReadBytes('\n'); err == nil {
		t.Fatalf("a connection past the cap was served while a drain held a slot: %s", line)
	}
}

func TestStoppingTheDaemonClosesTheConnectionsItIsDraining(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	holdDrains(t)
	a, ended := startEnding(t, ctx, rs)
	draining, active := drainingHolder(t, a, ended)
	a.d.Stop()
	err := <-a.done
	a.done <- err // for the cleanup's receive
	for _, h := range []*holder{draining, active} {
		if _, err := h.r.ReadBytes('\n'); !errors.Is(err, io.EOF) {
			t.Fatalf("a holder after the stop read %v, want the half-close", err)
		}
	}
	// A control slot is freed only by its connection's Close, so none held means every control connection is closed.
	if n := len(a.d.controlSlots); n != 0 {
		t.Fatalf("%d control connection(s) still open after Run returned", n)
	}
}
