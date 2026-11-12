package daemon

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/relaytest"
)

// A leave queues the view that revokes this node, replies, and stops the daemon at once. A watch
// still passes that view on before it ends, or a pen forward never learns that its own node left.
func TestAWatchDeliversTheViewQueuedBeforeTheDaemonStops(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	srv, cli := net.Pipe()
	defer cli.Close()
	go func() {
		a.d.controlWatch(ctx, srv)
		srv.Close()
	}()
	// net.Pipe does not buffer: one byte read means the watch is registered and still writing its
	// first line, so the leave's view is queued and the daemon stopped before the watch selects.
	head := make([]byte, 1)
	if _, err := io.ReadFull(cli, head); err != nil {
		t.Fatal(err)
	}
	if _, err := a.d.leave(ctx); err != nil {
		t.Fatal(err)
	}
	a.d.Stop()
	lines := bufio.NewScanner(io.MultiReader(bytes.NewReader(head), cli))
	for lines.Scan() {
		var w WatchLine
		if err := json.Unmarshal(lines.Bytes(), &w); err != nil {
			t.Fatal(err)
		}
		for _, r := range w.Revoked {
			if r.NodeID == a.d.NodeID() {
				return
			}
		}
	}
	t.Fatal("the watch ended without the view in which this node left")
}
