package cli

import (
	"errors"
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
	// trafficAnswerWithin bounds the wait for the daemon's answer to one report.
	trafficAnswerWithin = time.Second
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
// prints nothing and changes nothing for the session; the bytes stay for the next report.
type sessionTraffic struct {
	st          *state.Store
	node, relay string
	in, out     atomic.Uint64
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

// link counts the stream bytes l carries.
func (s *sessionTraffic) link(l stream.Link) stream.Link {
	return traffic.Meter(l, func(in, out uint64) {
		s.in.Add(in)
		s.out.Add(out)
	})
}

// finish stops the ticks and sends the last report.
func (s *sessionTraffic) finish() {
	close(s.stop)
	<-s.done
	s.report()
}

func (s *sessionTraffic) report() {
	in, out := min(s.in.Load()-s.sentIn, daemon.MaxTrafficCount), min(s.out.Load()-s.sentOut, daemon.MaxTrafficCount)
	if in == 0 && out == 0 {
		return
	}
	var ans struct {
		T string `json:"t"`
	}
	err := daemon.CallWithin(s.st, daemon.TrafficReport{Op: "traffic.report", Node: s.node, Relay: s.relay, In: in, Out: out},
		&ans, trafficAnswerWithin)
	if err == nil && ans.T != "counted" {
		err = errors.New("traffic report not counted")
	}
	if err == nil {
		s.sentIn += in
		s.sentOut += out
	}
	if trafficReported != nil {
		trafficReported(err)
	}
}
