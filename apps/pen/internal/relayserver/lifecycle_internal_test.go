package relayserver

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math"
	mrand "math/rand/v2"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// P1: a queue whose writer ends after its close frame gives back an unused reservation.
func TestAQueueThatClosesNormallyGivesBackItsReservation(t *testing.T) {
	s := New(DefaultLimits())
	q := newOutq(fastWS{}, time.Hour, testBudget(s, "192.0.2.1"))
	if !q.reserve(2 * sessionFrameCost) {
		t.Fatal("setup: no room for a reservation")
	}
	q.pushReserved(make([]byte, 5), sessionFrameCost)
	q.close(1000)
	q.wait()
	if got := s.Queued(); got != 0 {
		t.Fatalf("%d bytes still counted after the queue closed", got)
	}
}

// live is a relay on a real HTTP server whose finished sockets the test can count.
type live struct {
	s      *Server
	url    string
	origin string
	done   chan struct{}
	// counted receives once per session whose bytes reached the traffic totals.
	counted chan struct{}
	mu      sync.Mutex
	opened  int
	conns   []*websocket.Conn
	// stall names the client session whose next data write fails as a stalled peer's would;
	// stalled receives once it did.
	stallNode string
	stallSID  uint32
	// stallUplink names the node whose uplink's next write fails the same way.
	stallUplink string
	stalled     chan struct{}
	// authed[nodeID] receives once per uplink the relay accepted (Hooks.OnUplink).
	t      *testing.T
	authed map[string]chan struct{}
}

// failsafe bounds a wait for an event the test drives, so a missing event fails with a message
// instead of hanging; no outcome depends on it.
const failsafe = 30 * time.Second

func (lv *live) authedCh(nodeID string) chan struct{} {
	lv.mu.Lock()
	defer lv.mu.Unlock()
	ch := lv.authed[nodeID]
	if ch == nil {
		ch = make(chan struct{}, 1024)
		lv.authed[nodeID] = ch
	}
	return ch
}

func newLive(t *testing.T, l Limits) *live {
	s := New(l)
	lv := &live{s: s, done: make(chan struct{}, 1<<16), counted: make(chan struct{}, 1<<16), stalled: make(chan struct{}, 1), t: t, authed: map[string]chan struct{}{}}
	s.Hooks.OnSocketDone = func(string, string) { lv.done <- struct{}{} }
	s.Hooks.counted = func() { lv.counted <- struct{}{} }
	s.Hooks.OnUplink = func(nodeID string) { lv.authedCh(nodeID) <- struct{}{} }
	s.Hooks.failWrite = func(nodeID, role string, sid uint32) error {
		lv.mu.Lock()
		hit := role == "client" && nodeID == lv.stallNode && sid == lv.stallSID ||
			role == "node" && nodeID == lv.stallUplink
		lv.mu.Unlock()
		if !hit {
			return nil
		}
		select {
		case lv.stalled <- struct{}{}:
		default:
		}
		return errors.New("stalled peer")
	}
	hs := httptest.NewServer(s)
	t.Cleanup(hs.Close)
	lv.url = hs.URL
	lv.origin, _ = wire.RelayOrigin(hs.URL)
	return lv
}

func (lv *live) dial(path string) *websocket.Conn {
	u, _ := wire.WebSocketURL(lv.url, path)
	ws, _, err := websocket.Dial(context.Background(), u, nil)
	if err != nil {
		return nil
	}
	ws.SetReadLimit(-1)
	lv.mu.Lock()
	lv.opened++
	lv.conns = append(lv.conns, ws)
	lv.mu.Unlock()
	return ws
}

// liveNode is an uplink that reads and acks everything and remembers the sessions opened to it.
type liveNode struct {
	id    *ident.Identity
	ws    *websocket.Conn
	mu    sync.Mutex
	opens []uint32
	// opened receives each OPEN's sid as it arrives (dropped when full).
	opened chan uint32
	// frames receives each DATA and CLOSE frame as it arrives (dropped when full).
	frames chan wire.Frame
}

func (lv *live) uplink(id *ident.Identity, good bool) *liveNode {
	ws := lv.dial("/v1/node/" + id.NodeID())
	if ws == nil {
		return nil
	}
	ctx := context.Background()
	_, ch, err := ws.Read(ctx)
	if err != nil {
		return nil
	}
	answer := make([]byte, 96)
	if good {
		answer = relay.AnswerChallenge(id, lv.origin, ch)
	}
	ws.Write(ctx, websocket.MessageBinary, answer)
	n := &liveNode{id: id, ws: ws, opened: make(chan uint32, 64), frames: make(chan wire.Frame, 1024)}
	go func() {
		total, last := uint64(len(ch)), uint64(0)
		for {
			typ, p, err := ws.Read(ctx)
			if err != nil {
				return
			}
			if typ != websocket.MessageBinary {
				continue
			}
			if total += uint64(len(p)); total-last >= wire.AckEvery {
				last = total
				ws.Write(ctx, websocket.MessageText, []byte(wire.FormatAck(total)))
			}
			if f, err := wire.DecodeFrame(p); err == nil && f.Type == wire.FrameOpen {
				n.mu.Lock()
				n.opens = append(n.opens, f.SID)
				n.mu.Unlock()
				select {
				case n.opened <- f.SID:
				default:
				}
			} else if err == nil {
				select {
				case n.frames <- f:
				default:
				}
			}
		}
	}()
	if good {
		// Clients dialed before the relay accepted this uplink would reach no uplink (4404) or
		// the one it replaces.
		select {
		case <-lv.authedCh(id.NodeID()):
		case <-time.After(failsafe):
			lv.t.Fatalf("the relay did not accept the uplink of %s", id.NodeID())
		}
	}
	return n
}

// nextOpen is the sid of the next OPEN this uplink receives.
func (n *liveNode) nextOpen(t *testing.T) uint32 {
	t.Helper()
	select {
	case sid := <-n.opened:
		return sid
	case <-time.After(failsafe):
		t.Fatalf("no OPEN reached the uplink of %s", n.id.NodeID())
		return 0
	}
}

func (n *liveNode) someSID(r *mrand.Rand) (uint32, bool) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if len(n.opens) == 0 {
		return 0, false
	}
	return n.opens[r.IntN(len(n.opens))], true
}

// P1: whatever happens to sockets and sessions (uplinks replaced, failed authentication, clients
// that never read, first and second messages, node answers and closes, 4429 refusals, write
// timeouts, a relay shutdown), every counter is back to exactly zero once all sockets are gone.
func TestCountersReturnToZeroAfterAnySequenceOfSocketLifecycles(t *testing.T) {
	var mu sync.Mutex
	seen := map[string]int{}
	count := func(k string) {
		mu.Lock()
		seen[k]++
		mu.Unlock()
	}
	for seed := range uint64(6) {
		t.Run(fmt.Sprint(seed), func(t *testing.T) {
			l := DefaultLimits()
			// Only how fast stalled random sockets end; no assertion depends on it (the prelude drives
			// the write-failure path through the write-failure hook).
			l.WriteTimeout = 200 * time.Millisecond
			lv := newLive(t, l)
			lv.s.Hooks.OnEnd = func(role string, code uint16) { count(fmt.Sprintf("%s %d", role, code)) }
			lv.s.Hooks.OnWriteFailed = func(role string) { count(role + " write failed") }
			r := mrand.New(mrand.NewPCG(seed, 7))
			ctx := context.Background()
			var ids []*ident.Identity
			for range 3 {
				id, _ := ident.Generate(rand.Reader)
				ids = append(ids, id)
			}
			nodes := map[int]*liveNode{0: prelude(t, lv, ids)}
			var clients []*websocket.Conn
			for range 300 {
				i := r.IntN(len(ids))
				switch r.IntN(10) {
				case 0, 1:
					if n := lv.uplink(ids[i], true); n != nil {
						nodes[i] = n
					}
				case 2:
					lv.uplink(ids[i], false)
				case 3, 4:
					if c := lv.dial("/v1/client/" + ids[i].NodeID()); c != nil {
						clients = append(clients, c)
					}
				case 5:
					if len(clients) > 0 {
						clients[r.IntN(len(clients))].Write(ctx, websocket.MessageBinary, make([]byte, r.IntN(4097)))
					}
				case 6:
					if n := nodes[i]; n != nil {
						if sid, ok := n.someSID(r); ok {
							size := 2
							if r.IntN(4) == 0 {
								size = 256 << 10
							}
							n.ws.Write(ctx, websocket.MessageBinary, wire.Frame{Type: wire.FrameData, SID: sid, Payload: make([]byte, size)}.Encode())
						}
					}
				case 7:
					if n := nodes[i]; n != nil {
						if sid, ok := n.someSID(r); ok {
							n.ws.Write(ctx, websocket.MessageBinary, wire.CloseFrame(sid, 1000).Encode())
						}
					}
				case 8:
					if len(clients) > 0 {
						clients[r.IntN(len(clients))].CloseNow()
					}
				case 9:
					if n := nodes[i]; n != nil {
						n.ws.CloseNow()
						delete(nodes, i)
					}
				}
			}
			if seed%2 == 0 {
				lv.s.Close()
				count("relay shutdown")
			}
			lv.mu.Lock()
			for _, c := range lv.conns {
				c.CloseNow()
			}
			opened := lv.opened
			lv.mu.Unlock()
			for range opened {
				<-lv.done
			}
			lv.s.mu.Lock()
			shares, rooms := len(lv.s.shares), len(lv.s.rooms)
			lv.s.mu.Unlock()
			if lv.s.Queued() != 0 || lv.s.Reading() != 0 || shares != 0 || rooms != 0 {
				t.Fatalf("with every socket gone: %d queued, %d read bytes, %d address shares, %d rooms still counted",
					lv.s.Queued(), lv.s.Reading(), shares, rooms)
			}
			mu.Lock()
			defer mu.Unlock()
			want := []string{"node 4403", "node 4409", "client 4404", "client 4429", "client 4408", "client 1000", "client write failed"}
			if seed%2 == 0 {
				want = append(want, "relay shutdown")
			}
			for _, path := range want {
				if seen[path] == 0 {
					t.Errorf("seed %d never took the exit path %q (seen: %v)", seed, path, seen)
				}
			}
			clear(seen)
		})
	}
}

// T1: the per-room session id counter wraps past 0xffffffff to 1 and skips ids still live, so a
// wrap never sends the node a second OPEN for a live session (which would end its uplink).
func TestAWrappedSessionIDSkipsTheLiveOnes(t *testing.T) {
	lv := newLive(t, DefaultLimits())
	id, _ := ident.Generate(rand.Reader)
	n := lv.uplink(id, true)
	if n == nil {
		t.Fatal("uplink refused")
	}
	lv.s.mu.Lock()
	rm := lv.s.rooms[id.NodeID()]
	lv.s.mu.Unlock()
	first := lv.dial("/v1/client/" + id.NodeID())
	if got := n.nextOpen(t); got != 1 {
		t.Fatalf("first session got sid %d, want 1", got)
	}
	rm.mu.Lock()
	rm.sid = math.MaxUint32
	rm.mu.Unlock()
	lv.dial("/v1/client/" + id.NodeID())
	if got := n.nextOpen(t); got != 2 {
		t.Fatalf("after the wrap the new session got sid %d, want 2 (1 is live)", got)
	}
	rm.mu.Lock()
	k := rm.clients[1]
	rm.mu.Unlock()
	if k == nil || k.closed {
		t.Fatal("the session that holds sid 1 ended")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := first.Write(ctx, websocket.MessageBinary, []byte("still here")); err != nil {
		t.Fatal(err)
	}
}

func TestPendingEvictsFirstAcrossSessionIDWrap(t *testing.T) {
	lv := newLive(t, DefaultLimits())
	id, _ := ident.Generate(rand.Reader)
	n := lv.uplink(id, true)
	if n == nil {
		t.Fatal("uplink refused")
	}
	lv.s.mu.Lock()
	rm := lv.s.rooms[id.NodeID()]
	lv.s.mu.Unlock()
	rm.mu.Lock()
	rm.sid = math.MaxUint32 - 1
	rm.mu.Unlock()
	var ids []uint32
	for range PendingMax + 1 {
		if lv.dial("/v1/client/"+id.NodeID()) == nil {
			t.Fatal("client refused")
		}
		ids = append(ids, <-n.opened)
	}
	rm.mu.Lock()
	defer rm.mu.Unlock()
	if _, ok := rm.clients[ids[0]]; ok {
		t.Errorf("first pending session %d remains; session %d was evicted", ids[0], ids[1])
	}
	if _, ok := rm.clients[ids[1]]; !ok {
		t.Errorf("newer pending session %d was evicted", ids[1])
	}
}

// prelude drives each exit path once so every seed covers them, whatever its random steps do.
func prelude(t *testing.T, lv *live, ids []*ident.Identity) *liveNode {
	ctx := context.Background()
	if lv.uplink(ids[1], false) == nil {
		t.Fatal("prelude: an uplink failing authentication was refused before its challenge")
	}
	old := lv.uplink(ids[0], true)
	orphan := lv.dial("/v1/client/" + ids[0].NodeID())
	old.nextOpen(t)
	n := lv.uplink(ids[0], true) // replaces old (4409); orphan ends 4404
	_ = orphan
	for range 9 { // the ninth pending session ends the oldest 4429
		lv.dial("/v1/client/" + ids[0].NodeID())
		n.nextOpen(t)
	}
	twice := lv.dial("/v1/client/" + ids[0].NodeID())
	n.nextOpen(t)
	twice.Write(ctx, websocket.MessageBinary, []byte("first"))
	twice.Write(ctx, websocket.MessageBinary, []byte("second")) // 4408
	closed := lv.dial("/v1/client/" + ids[0].NodeID())
	sid := n.nextOpen(t)
	n.ws.Write(ctx, websocket.MessageBinary, wire.CloseFrame(sid, 1000).Encode())
	if _, _, err := closed.Read(ctx); err == nil {
		t.Fatal("prelude: the session the node closed is still open")
	}
	// A client whose write fails as a stalled one's would: the hook fails it, so no kernel buffer
	// or timer decides whether this path is taken.
	lv.dial("/v1/client/" + ids[0].NodeID())
	sid = n.nextOpen(t)
	lv.mu.Lock()
	lv.stallNode, lv.stallSID = ids[0].NodeID(), sid
	lv.mu.Unlock()
	n.ws.Write(ctx, websocket.MessageBinary, wire.Frame{Type: wire.FrameData, SID: sid, Payload: []byte("to a stalled client")}.Encode())
	select {
	case <-lv.stalled:
	case <-time.After(failsafe):
		t.Fatal("prelude: the stalled client's write was never attempted")
	}
	return n
}
