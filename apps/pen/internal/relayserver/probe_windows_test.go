package relayserver

import (
	"context"
	"fmt"
	"runtime"
	"testing"

	"github.com/coder/websocket"
)

// Diagnostic only (never merged): how often the open-session summary sees bytes a socket already read but the
// relay has not counted, without and with a ping/pong barrier on both sockets. One Errorf prints the log.
func TestWindowsSummaryProbe(t *testing.T) {
	ctx := context.Background()
	run := func(barrier bool) (fails int, first string) {
		for i := range 50 {
			id := newID(t)
			lv, _, log := trafficLive(t, id)
			n := lv.uplink(id, true)
			c, sid := lv.session(t, n)
			send(t, c, 300)
			n.nextFrame(t, sid)
			n.data(t, sid, 800)
			receive(t, c, 800)
			if barrier {
				if err := n.ws.Write(ctx, websocket.MessageText, []byte("ping")); err != nil {
					t.Fatal(err)
				}
				<-n.pongs
				if err := c.Write(ctx, websocket.MessageText, []byte("ping")); err != nil {
					t.Fatal(err)
				}
				if typ, p, err := c.Read(ctx); err != nil || typ != websocket.MessageText || string(p) != "pong" {
					t.Fatalf("client read %q (%v) after its ping", p, err)
				}
			}
			lv.s.Summarize()
			nodes := log.lines(t, "node")
			if len(nodes) != 1 || nodes[0]["toNode"] != float64(300) || nodes[0]["fromNode"] != float64(800) {
				fails++
				if first == "" {
					first = fmt.Sprintf("iteration %d: node lines %v; log:\n%s", i, nodes, log.raw())
				}
			}
			c.Close(websocket.StatusNormalClosure, "")
		}
		return fails, first
	}
	t.Logf("go %s GOMAXPROCS %d", runtime.Version(), runtime.GOMAXPROCS(0))
	for _, barrier := range []bool{false, true} {
		fails, first := run(barrier)
		t.Logf("barrier %v: %d of 50 summaries missed counted bytes; first: %s", barrier, fails, first)
	}
	t.Errorf("summary probe done: deliberate failure so go test prints the lines above")
}
