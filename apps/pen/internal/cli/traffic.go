package cli

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"net"
	"sync/atomic"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/state"
	"github.com/goat-si/goat/apps/pen/internal/stream"
	"github.com/goat-si/goat/apps/pen/internal/traffic"
)

const (
	// trafficEvery is how often a running session reports its bytes to this machine's daemon.
	trafficEvery = 2 * time.Minute
	// trafficWithin bounds one report: connecting, writing and the daemon's answer.
	trafficWithin = time.Second
)

var (
	// trafficTicks makes a session's report ticks; tests tick by hand.
	trafficTicks = func() (<-chan time.Time, func()) {
		t := time.NewTicker(trafficEvery)
		return t.C, t.Stop
	}
	// trafficReported, when set, is told the result of every report a session sends (tests).
	trafficReported func(error)
)

// sessionTraffic counts one session's stream bytes and reports them to this machine's daemon (op traffic.report)
// every trafficEvery and once at the end. Reports are best effort: no daemon, an older daemon or a failed report
// prints nothing and changes nothing for the session. Bytes the daemon certainly did not count stay for the next
// report; a report whose answer never came may have been counted, so its bytes are not sent again.
type sessionTraffic struct {
	st          *state.Store
	node, relay string
	in, out     atomic.Uint64
	metered     *traffic.Metered
	// sentIn and sentOut are what the daemon acknowledged; only report and finish touch them, one at a time.
	sentIn, sentOut uint64
	stop, done      chan struct{}
}

func startTraffic(st *state.Store, node, relay string) *sessionTraffic {
	s := &sessionTraffic{st: st, node: node, relay: relay, stop: make(chan struct{}), done: make(chan struct{})}
	ticks, stopTicks := trafficTicks()
	go func() {
		defer close(s.done)
		defer stopTicks()
		for {
			select {
			case <-ticks:
				s.report()
			case <-s.stop:
				return
			}
		}
	}()
	return s
}

// link counts the stream bytes l carries; call it once per session.
func (s *sessionTraffic) link(l stream.Link) stream.Link {
	s.metered = traffic.Meter(l, func(in, out uint64) {
		s.in.Add(in)
		s.out.Add(out)
	})
	return s.metered
}

// finish stops the ticks, lets sends and receives still returning count, and sends the last report.
func (s *sessionTraffic) finish() {
	close(s.stop)
	<-s.done
	if s.metered != nil {
		s.metered.Settle(trafficWithin)
	}
	s.report()
}

func (s *sessionTraffic) report() {
	in, out := min(s.in.Load()-s.sentIn, daemon.MaxTrafficCount), min(s.out.Load()-s.sentOut, daemon.MaxTrafficCount)
	if in == 0 && out == 0 {
		return
	}
	kept, err := sendReport(s.st, daemon.TrafficReport{Op: "traffic.report", Node: s.node, Relay: s.relay, In: in, Out: out})
	if !kept {
		s.sentIn += in
		s.sentOut += out
	}
	if trafficReported != nil {
		trafficReported(err)
	}
}

// sendReport sends one report and reads its answer within trafficWithin. kept is true when the daemon did not count
// the bytes: the line never reached it whole, or it refused the report (an older daemon does not know the op).
func sendReport(st *state.Store, r daemon.TrafficReport) (kept bool, err error) {
	deadline := time.Now().Add(trafficWithin)
	c, err := (&net.Dialer{Deadline: deadline}).Dial("unix", daemon.SocketPath(st))
	if err != nil {
		return true, err
	}
	defer c.Close()
	if err := c.SetDeadline(deadline); err != nil {
		return true, err
	}
	line, err := json.Marshal(r)
	if err != nil {
		return true, err
	}
	if n, err := c.Write(append(line, '\n')); err != nil && n <= len(line) {
		return true, err
	}
	ans, err := bufio.NewReader(io.LimitReader(c, 4096)).ReadBytes('\n')
	if err != nil {
		return false, err
	}
	var a struct {
		T     string `json:"t"`
		Error string `json:"error"`
	}
	switch {
	case json.Unmarshal(ans, &a) != nil:
		return false, errors.New("traffic report: unreadable answer")
	case a.T == "counted":
		return false, nil
	case a.Error != "":
		return true, errors.New(a.Error)
	}
	return false, errors.New("traffic report: unexpected answer")
}
