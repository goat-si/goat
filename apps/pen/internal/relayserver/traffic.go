package relayserver

import (
	"encoding/json"
	"io"
	"slices"
	"sync"
	"time"
)

// Traffic accounting: one log line per session the node answered, byte totals per node kept in
// memory, and a summary every SummaryEvery. Lines carry a node id prefix and counts only: no
// address, no full node id, nothing from a session's contents.
const (
	// NodePrefixLen is what lines show of a node id: what pen ls shows, 40 of its 128 bits.
	NodePrefixLen = 8
	// MaxTrackedNodes bounds the per-node totals; past it the least recently active node is dropped.
	MaxTrackedNodes = 256
	// SummaryEvery is how often the relay writes its totals (only when something changed).
	SummaryEvery = 10 * time.Minute
	// SessionLineBurst and SessionLinesPerSecond bound session lines; past them a line is dropped
	// and counted, while the totals stay exact.
	SessionLineBurst      = 120
	SessionLinesPerSecond = 1
)

type traffic struct {
	// now, maxNodes, burst and rate are the defaults above unless a test sets them.
	now      func() time.Time
	maxNodes int
	burst    float64
	rate     float64

	start sync.Once
	// summary serializes summaries from collection to output, so the last one (Close) never runs
	// while a timer summary holds bytes it took from sessions but has not counted yet.
	summary sync.Mutex
	mu      sync.Mutex
	timer   *time.Timer
	// since is when counting began; tokens and refilled are the session line bucket.
	since    time.Time
	tokens   float64
	refilled time.Time
	nodes    map[string]*nodeTally
	relay    relayTally
	changed  bool
	closed   bool
}

type tally struct {
	toNode, fromNode, sessions uint64
}

type nodeTally struct {
	tally
	since, last time.Time
	changed     bool
}

type relayTally struct {
	tally
	unanswered, linesDropped, evicted uint64
}

// sessionEnd is what a session's socket reports when it is done.
type sessionEnd struct {
	node             string
	toNode, fromNode uint64 // the whole session
	newTo, newFrom   uint64 // not yet in the totals
	answered         bool
	admitted, ended  time.Time
	by               string
	code             uint16
}

func (t *traffic) clock() time.Time {
	if t.now != nil {
		return t.now()
	}
	return time.Now()
}

func prefix(nodeID string) string {
	if len(nodeID) > NodePrefixLen {
		return nodeID[:NodePrefixLen]
	}
	return nodeID
}

// addLocked adds counts to node's totals, making room for a node not tracked yet.
func (t *traffic) addLocked(node string, to, from, sessions uint64, at time.Time) {
	t.relay.toNode += to
	t.relay.fromNode += from
	t.relay.sessions += sessions
	t.changed = true
	n := t.nodes[node]
	if n == nil {
		if t.nodes == nil {
			t.nodes = map[string]*nodeTally{}
		}
		max := t.maxNodes
		if max <= 0 {
			max = MaxTrackedNodes
		}
		for len(t.nodes) >= max {
			var oldest string
			for k, v := range t.nodes {
				if oldest == "" || v.last.Before(t.nodes[oldest].last) || v.last.Equal(t.nodes[oldest].last) && k < oldest {
					oldest = k
				}
			}
			delete(t.nodes, oldest)
			t.relay.evicted++
		}
		n = &nodeTally{since: at}
		t.nodes[node] = n
	}
	n.toNode += to
	n.fromNode += from
	n.sessions += sessions
	n.last = at
	n.changed = true
}

// takeTokenLocked reports whether a session line may be written now.
func (t *traffic) takeTokenLocked(at time.Time) bool {
	burst, rate := t.burst, t.rate
	if burst <= 0 {
		burst = SessionLineBurst
	}
	if rate <= 0 {
		rate = SessionLinesPerSecond
	}
	if t.refilled.IsZero() {
		t.tokens = burst
	} else if d := at.Sub(t.refilled); d > 0 {
		t.tokens = min(burst, t.tokens+d.Seconds()*rate)
	}
	t.refilled = at
	if t.tokens < 1 {
		return false
	}
	t.tokens--
	return true
}

func (t *traffic) sinceLocked(at time.Time) {
	if t.since.IsZero() {
		t.since = at
	}
}

// ended accounts for a session whose socket is done and writes its line to w.
func (t *traffic) ended(w io.Writer, e sessionEnd) {
	t.mu.Lock()
	defer t.mu.Unlock()
	at := e.ended
	t.sinceLocked(at)
	if !e.answered {
		t.relay.unanswered++
		t.addLocked(e.node, e.newTo, e.newFrom, 0, at)
		return
	}
	t.addLocked(e.node, e.newTo, e.newFrom, 1, at)
	if !t.takeTokenLocked(at) {
		t.relay.linesDropped++
		return
	}
	writeLine(w, sessionLine{Event: "session", Node: e.node, ToNode: e.toNode, FromNode: e.fromNode,
		Ms: e.ended.Sub(e.admitted).Milliseconds(), End: e.by, Code: e.code, At: stamp(at)})
}

// liveBytes is what open sessions of one node relayed since they were last counted.
type liveBytes struct {
	node     string
	to, from uint64
}

// summarize adds live sessions' new bytes and writes one line per node that changed since the
// last summary and one for the relay; it writes nothing when nothing changed.
func (t *traffic) summarize(w io.Writer, live []liveBytes) {
	t.mu.Lock()
	defer t.mu.Unlock()
	at := t.clock()
	t.sinceLocked(at)
	for _, l := range live {
		if l.to != 0 || l.from != 0 {
			t.addLocked(l.node, l.to, l.from, 0, at)
		}
	}
	if !t.changed {
		return
	}
	t.changed = false
	keys := make([]string, 0, len(t.nodes))
	for k, n := range t.nodes {
		if n.changed {
			keys = append(keys, k)
		}
	}
	slices.Sort(keys)
	for _, k := range keys {
		n := t.nodes[k]
		n.changed = false
		writeLine(w, nodeLine{Event: "node", Node: k, ToNode: n.toNode, FromNode: n.fromNode, Sessions: n.sessions,
			Since: stamp(n.since), At: stamp(at)})
	}
	r := t.relay
	writeLine(w, relayLine{Event: "relay", ToNode: r.toNode, FromNode: r.fromNode, Sessions: r.sessions,
		Unanswered: r.unanswered, LinesDropped: r.linesDropped, Nodes: len(t.nodes), Evicted: r.evicted,
		Since: stamp(t.since), At: stamp(at)})
}

type sessionLine struct {
	Event    string `json:"event"`
	Node     string `json:"node"`
	ToNode   uint64 `json:"toNode"`
	FromNode uint64 `json:"fromNode"`
	Ms       int64  `json:"ms"`
	End      string `json:"end"`
	Code     uint16 `json:"code"`
	At       string `json:"at"`
}

type nodeLine struct {
	Event    string `json:"event"`
	Node     string `json:"node"`
	ToNode   uint64 `json:"toNode"`
	FromNode uint64 `json:"fromNode"`
	Sessions uint64 `json:"sessions"`
	Since    string `json:"since"`
	At       string `json:"at"`
}

type relayLine struct {
	Event        string `json:"event"`
	ToNode       uint64 `json:"toNode"`
	FromNode     uint64 `json:"fromNode"`
	Sessions     uint64 `json:"sessions"`
	Unanswered   uint64 `json:"unanswered"`
	LinesDropped uint64 `json:"linesDropped"`
	Nodes        int    `json:"nodes"`
	Evicted      uint64 `json:"evicted"`
	Since        string `json:"since"`
	At           string `json:"at"`
}

func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339) }

func writeLine(w io.Writer, v any) {
	b, _ := json.Marshal(v)
	w.Write(append(b, '\n'))
}

// trafficStart arms the summary timer once, when the relay has a traffic log.
func (s *Server) trafficStart() {
	if s.TrafficLog == nil {
		return
	}
	s.traffic.start.Do(func() {
		s.traffic.mu.Lock()
		defer s.traffic.mu.Unlock()
		if s.traffic.closed {
			return
		}
		s.traffic.timer = time.AfterFunc(SummaryEvery, s.summaryTick)
	})
}

func (s *Server) summaryTick() {
	s.Summarize()
	s.traffic.mu.Lock()
	defer s.traffic.mu.Unlock()
	if !s.traffic.closed {
		s.traffic.timer.Reset(SummaryEvery)
	}
}

// Summarize writes the traffic totals now (the relay also does so every SummaryEvery and on Close).
func (s *Server) Summarize() {
	if s.TrafficLog == nil {
		return
	}
	s.traffic.summary.Lock()
	defer s.traffic.summary.Unlock()
	s.mu.Lock()
	rooms := make([]*room, 0, len(s.rooms))
	for _, rm := range s.rooms {
		rooms = append(rooms, rm)
	}
	s.mu.Unlock()
	var live []liveBytes
	for _, rm := range rooms {
		rm.mu.Lock()
		for _, c := range rm.clients {
			if d := c.takeNew(); d.to != 0 || d.from != 0 {
				live = append(live, liveBytes{node: prefix(rm.nodeID), to: d.to, from: d.from})
			}
		}
		rm.mu.Unlock()
	}
	s.traffic.summarize(s.TrafficLog, live)
}

// takeNew is what the session relayed since it was last counted, now counted; rm.mu held.
func (k *sock) takeNew() (d struct{ to, from uint64 }) {
	d.to, d.from = k.toNode-k.countedTo, k.fromNode-k.countedFrom
	k.countedTo, k.countedFrom = k.toNode, k.fromNode
	return d
}

// sessionDone reports an admitted client socket's session once the socket is done.
func (s *Server) sessionDone(k *sock) {
	if s.TrafficLog == nil {
		return
	}
	rm := k.room
	rm.mu.Lock()
	d := k.takeNew()
	e := sessionEnd{node: prefix(k.nodeID), toNode: k.toNode, fromNode: k.fromNode, newTo: d.to, newFrom: d.from,
		answered: k.answered, admitted: k.admitted, ended: k.endedAt, by: k.endedBy, code: k.endCode}
	rm.mu.Unlock()
	s.traffic.ended(s.TrafficLog, e)
}

// waitHandlers waits up to d for every socket handler to end. On a timeout the waiting goroutine
// ends with the last handler.
func (s *Server) waitHandlers(d time.Duration) {
	done := make(chan struct{})
	go func() {
		s.handlers.Wait()
		close(done)
	}()
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-done:
	case <-t.C:
	}
}

// trafficStop writes the totals one last time and stops the summary timer.
func (s *Server) trafficStop() {
	s.Summarize()
	s.traffic.mu.Lock()
	defer s.traffic.mu.Unlock()
	s.traffic.closed = true
	if s.traffic.timer != nil {
		s.traffic.timer.Stop()
	}
}
