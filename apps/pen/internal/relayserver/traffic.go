package relayserver

import (
	"encoding/json"
	"io"
	"slices"
	"sync"
	"sync/atomic"
	"time"
)

// Traffic accounting: payload bytes the relay delivered for each session, relay-wide totals, and
// for the node ids the operator lists (TrafficNodes) per-node totals and one line per answered
// session. Lines carry a node id prefix and counts only: no address, no full node id, nothing
// from a session's contents. Anyone can mint node ids, so only listed ones get entries or lines.
const (
	// NodePrefixLen is what lines show of a node id: what pen ls shows, 40 of its 128 bits.
	NodePrefixLen = 8
	// MaxTrafficNodes is how many node ids TrafficNodes may list.
	MaxTrafficNodes = 256
	// SummaryEvery is how often the relay writes its totals (only when something changed).
	SummaryEvery = 10 * time.Minute
	// SessionLineBurst and SessionLinesPerSecond bound session lines; past them a line is dropped
	// and counted, while the totals stay exact.
	SessionLineBurst      = 120
	SessionLinesPerSecond = 1
	// LogQueue is how many lines wait for a slow log; past it a line is dropped and counted.
	LogQueue = 1024
	// finalSummaries is how many times Close writes the totals while the log fails some of them.
	finalSummaries = 3
)

type traffic struct {
	// now, burst, rate, queue and after are the defaults unless a test sets them.
	now   func() time.Time
	burst float64
	rate  float64
	queue int
	after func(time.Duration) (<-chan time.Time, func() bool)

	start sync.Once
	// summary serializes summaries from collection to output, so the last one (Close) never runs
	// while a timer summary holds bytes it took from sessions but has not counted yet.
	summary sync.Mutex
	// mu is a leaf: nothing is written or locked while it is held.
	mu    sync.Mutex
	timer *time.Timer
	// since is when counting began; tokens and refilled are the session line bucket.
	since    time.Time
	tokens   float64
	refilled time.Time
	nodes    map[string]*nodeTally // listed nodes only
	relay    relayTally
	changed  bool
	closed   bool
	// lines feeds the log writer; written closes once it has written or dropped the last line.
	lines   chan logItem
	written chan struct{}
}

// logItem is one line for the log writer; ack, when set, is closed once the lines before it are written.
type logItem struct {
	b   []byte
	ack chan struct{}
}

type tally struct {
	toNode, fromNode, sessions uint64
}

type nodeTally struct {
	tally
	since   time.Time
	changed bool
}

type relayTally struct {
	tally
	unanswered, linesDropped uint64
}

// sessionTally is one session's delivered bytes. The writers of its client socket and of the
// uplink add to it after each write that succeeded; it is counted once both have let go of it.
type sessionTally struct {
	srv    *Server
	node   string
	listed bool
	// Payload bytes written toward the node and toward the client, and what the totals hold.
	toNode, fromNode       atomic.Uint64
	countedTo, countedFrom atomic.Uint64
	// refs: the client socket, and the uplink queue while it may hold the session's frames.
	refs atomic.Int32
	// Set by the client socket before it lets go.
	answered        bool
	admitted, ended time.Time
	by              string
	code            uint16
}

// take is what total grew by since it was last taken, now taken.
func take(total, counted *atomic.Uint64) uint64 {
	cur := total.Load()
	for {
		prev := counted.Load()
		if cur <= prev {
			return 0
		}
		if counted.CompareAndSwap(prev, cur) {
			return cur - prev
		}
	}
}

func (t *sessionTally) release() {
	if t.refs.Add(-1) == 0 {
		t.srv.traffic.ended(t)
		if f := t.srv.Hooks.counted; f != nil {
			f()
		}
	}
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

// addLocked adds counts to the relay's totals and, for a listed node, to that node's.
func (t *traffic) addLocked(node string, listed bool, to, from, sessions uint64, at time.Time) {
	t.relay.toNode += to
	t.relay.fromNode += from
	t.relay.sessions += sessions
	t.changed = true
	if !listed {
		return
	}
	n := t.nodes[node]
	if n == nil {
		if t.nodes == nil {
			t.nodes = map[string]*nodeTally{}
		}
		n = &nodeTally{since: at}
		t.nodes[node] = n
	}
	n.toNode += to
	n.fromNode += from
	n.sessions += sessions
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
	// Sessions reach here out of end-time order, so refilled only moves forward: an older end
	// time must not refill the same seconds again.
	if t.refilled.IsZero() {
		t.tokens = burst
		t.refilled = at
	} else if d := at.Sub(t.refilled); d > 0 {
		t.tokens = min(burst, t.tokens+d.Seconds()*rate)
		t.refilled = at
	}
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

// emitLocked queues a line for the log writer, or drops and counts it when the queue is full; it
// reports whether the line was queued. A drop marks the totals changed, so the next summary shows it.
func (t *traffic) emitLocked(v any) bool {
	if t.lines == nil || t.closed {
		t.relay.linesDropped++
		return false
	}
	b, _ := json.Marshal(v)
	select {
	case t.lines <- logItem{b: append(b, '\n')}:
		return true
	default:
		t.relay.linesDropped++
		t.changed = true
		return false
	}
}

// ended counts a session both of whose sockets are done with it. It may run under a room's or a
// queue's lock: it takes only mu and never blocks.
func (t *traffic) ended(s *sessionTally) {
	to, from := take(&s.toNode, &s.countedTo), take(&s.fromNode, &s.countedFrom)
	t.mu.Lock()
	defer t.mu.Unlock()
	at := s.ended
	t.sinceLocked(at)
	var sessions uint64
	if s.answered {
		sessions = 1
	} else {
		t.relay.unanswered++
	}
	t.addLocked(s.node, s.listed, to, from, sessions, at)
	if !s.answered || !s.listed {
		return
	}
	if !t.takeTokenLocked(at) {
		t.relay.linesDropped++
		return
	}
	t.emitLocked(sessionLine{Event: "session", Node: s.node, ToNode: s.toNode.Load(), FromNode: s.fromNode.Load(),
		Ms: s.ended.Sub(s.admitted).Milliseconds(), End: s.by, Code: s.code, At: stamp(at)})
}

// liveBytes is what an open session delivered since it was last counted.
type liveBytes struct {
	node     string
	listed   bool
	to, from uint64
}

// summarize adds live sessions' new bytes and queues one line per listed node that changed since
// the last summary and one for the relay; it queues nothing when nothing changed.
func (t *traffic) summarize(live []liveBytes) {
	t.mu.Lock()
	defer t.mu.Unlock()
	at := t.clock()
	t.sinceLocked(at)
	for _, l := range live {
		if l.to != 0 || l.from != 0 {
			t.addLocked(l.node, l.listed, l.to, l.from, 0, at)
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
		// A line that did not fit stays changed and goes out at the next summary.
		n.changed = !t.emitLocked(nodeLine{Event: "node", Node: k, ToNode: n.toNode, FromNode: n.fromNode, Sessions: n.sessions,
			Since: stamp(n.since), At: stamp(at)})
	}
	r := t.relay
	t.emitLocked(relayLine{Event: "relay", ToNode: r.toNode, FromNode: r.fromNode, Sessions: r.sessions,
		Unanswered: r.unanswered, LinesDropped: r.linesDropped, Nodes: len(t.nodes), Since: stamp(t.since), At: stamp(at)})
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
	Since        string `json:"since"`
	At           string `json:"at"`
}

func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// write is the log writer: the only goroutine that writes to the traffic log. A line the log does
// not take whole counts as dropped and marks every total changed, so the next summary writes them
// again. A log that never returns from Write keeps this one goroutine, holding at most the queue,
// until the process exits: Close stops waiting for it after WriteTimeout.
func (t *traffic) write(w io.Writer, lines <-chan logItem, written chan<- struct{}) {
	defer close(written)
	for it := range lines {
		if it.ack != nil {
			close(it.ack)
			continue
		}
		if n, err := w.Write(it.b); err != nil || n < len(it.b) {
			t.mu.Lock()
			t.relay.linesDropped++
			t.changed = true
			for _, node := range t.nodes {
				node.changed = true
			}
			t.mu.Unlock()
		}
	}
}

// wait returns when done closes or d passes, whichever is first.
func (t *traffic) wait(done <-chan struct{}, d time.Duration) {
	after := t.after
	if after == nil {
		after = func(d time.Duration) (<-chan time.Time, func() bool) {
			tm := time.NewTimer(d)
			return tm.C, tm.Stop
		}
	}
	fired, stop := after(d)
	defer stop()
	select {
	case <-done:
	case <-fired:
	}
}

// trafficStart starts the log writer and arms the summary timer once, when the relay has a log.
func (s *Server) trafficStart() {
	if s.TrafficLog == nil {
		return
	}
	s.traffic.start.Do(func() {
		t := &s.traffic
		t.mu.Lock()
		defer t.mu.Unlock()
		if t.closed {
			return
		}
		n := t.queue
		if n <= 0 {
			n = LogQueue
		}
		t.lines, t.written = make(chan logItem, n), make(chan struct{})
		go t.write(s.TrafficLog, t.lines, t.written)
		t.timer = time.AfterFunc(SummaryEvery, s.summaryTick)
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

// Summarize queues the traffic totals now (the relay also does so every SummaryEvery and on Close).
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
			if t := c.tally; t != nil {
				live = append(live, liveBytes{node: t.node, listed: t.listed,
					to: take(&t.toNode, &t.countedTo), from: take(&t.fromNode, &t.countedFrom)})
			}
		}
		rm.mu.Unlock()
	}
	s.traffic.summarize(live)
}

// trackSession gives an admitted client its tally, counted by its own queue and the uplink's;
// rm.mu held.
func (s *Server) trackSession(k, up *sock) {
	if s.TrafficLog == nil {
		return
	}
	t := &sessionTally{srv: s, node: prefix(k.nodeID), listed: s.TrafficNodes[k.nodeID]}
	t.refs.Store(1)
	k.tally = t
	k.out.setOwn(t)
	if up.out.track(k.sid, t) {
		k.tallyQ = up.out
	}
}

// sessionDone lets go of an admitted client's tally once its socket is done.
func (s *Server) sessionDone(k *sock) {
	if k.tally == nil {
		return
	}
	rm := k.room
	rm.mu.Lock()
	t := k.tally
	t.answered, t.admitted, t.ended, t.by, t.code = k.answered, k.admitted, k.endedAt, k.endedBy, k.endCode
	rm.mu.Unlock()
	t.release()
}

// trafficStop writes the totals one last time, again while the log fails some of their lines (at
// most finalSummaries times), stops the summary timer and waits for the log writer; all of it
// within WriteTimeout, so a log that stopped reading does not hold the shutdown. Lines the log
// still refuses after that are lost.
func (s *Server) trafficStop() {
	t := &s.traffic
	after := t.after
	if after == nil {
		after = func(d time.Duration) (<-chan time.Time, func() bool) {
			tm := time.NewTimer(d)
			return tm.C, tm.Stop
		}
	}
	deadline, stop := after(s.Limits.WriteTimeout)
	defer stop()
	// A timer's channel fires once: expired remembers that it did.
	expired := false
	for range finalSummaries {
		s.Summarize()
		taken, late := t.flushed(deadline)
		expired = late
		if !taken {
			break
		}
		t.mu.Lock()
		again := t.changed
		t.mu.Unlock()
		if !again {
			break
		}
	}
	t.mu.Lock()
	t.closed = true
	if t.timer != nil {
		t.timer.Stop()
	}
	if t.lines != nil {
		close(t.lines)
	}
	written := t.written
	t.mu.Unlock()
	if written != nil && !expired {
		select {
		case <-written:
		case <-deadline:
		}
	}
}

// flushed reports whether the log writer took every line queued so far before deadline, and
// whether deadline fired. It holds no lock while it waits: the writer takes mu when a line fails.
func (t *traffic) flushed(deadline <-chan time.Time) (taken, expired bool) {
	t.mu.Lock()
	lines := t.lines
	t.mu.Unlock()
	if lines == nil {
		return false, false
	}
	ack := make(chan struct{})
	select {
	case lines <- logItem{ack: ack}:
	case <-deadline:
		return false, true
	}
	select {
	case <-ack:
		return true, false
	case <-deadline:
		return false, true
	}
}
