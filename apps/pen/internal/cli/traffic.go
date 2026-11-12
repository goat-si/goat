package cli

import (
	"bufio"
	"context"
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
	// trafficNow reads both clocks for the reporter; tests set it.
	trafficNow = func() clockReading {
		t := time.Now()
		return clockReading{wall: t.Round(0), mono: t.Sub(clockStart)}
	}
	// trafficPeriodic bounds one periodic report; tests take the bound away.
	trafficPeriodic = func(ctx context.Context) (context.Context, context.CancelFunc) {
		return context.WithTimeout(ctx, trafficWithin)
	}
	// trafficShutdown bounds the end of a session: the periodic report in flight, the meter settling and the last
	// report all end by its deadline. Tests end it by hand.
	trafficShutdown = func() (context.Context, context.CancelFunc) {
		return context.WithTimeout(context.Background(), trafficWithin)
	}
	// trafficReported, when set, is told the result of every report a session sends (tests).
	trafficReported func(error)
)

// clockReading is one reading of both clocks: wall places bytes in the daemon's buckets, which follow the wall
// clock; mono (time since clockStart) measures how long bytes have waited, which a clock being set does not change.
type clockReading struct {
	wall time.Time
	mono time.Duration
}

var clockStart = time.Now()

// clockStep is how far the wall clock may move apart from the monotonic one between two reports before the reporter
// takes it for a step: a clock set, or a sleep the monotonic clock did not count.
const clockStep = time.Second

// sessionTraffic counts one session's stream bytes and reports them to this machine's daemon (op traffic.report)
// every trafficEvery and once at the end. Reports are best effort: no daemon, an older daemon or a failed report
// prints nothing and changes nothing for the session. Bytes the daemon certainly did not count wait for the next
// report, but for less than one window bucket (traffic.Span): older ones are dropped, so they are never counted in a
// later bucket than the one they crossed the relay in by more than that. A report whose answer never came may have
// been counted, so its bytes are not sent again.
type sessionTraffic struct {
	st          *state.Store
	node, relay string
	in, out     atomic.Uint64
	metered     *traffic.Metered
	// ctx ends a periodic report still in flight when the session's shutdown deadline passes.
	ctx    context.Context
	cancel context.CancelFunc
	// Touched by report only, one call at a time: sentIn and sentOut are settled (counted, possibly counted, or
	// dropped); held are the bytes refused or unsent reports added, oldest first; lastTry is when the last report was
	// due, where bytes not yet in a report begin.
	sentIn, sentOut uint64
	held            []heldBatch
	lastTry         clockReading
	stop, done      chan struct{}
}

// heldBatch is what one refused or unsent report added: bytes that crossed the relay from since on.
type heldBatch struct {
	in, out uint64
	since   clockReading
}

// maxHeld bounds the batches held at once. A batch is dropped a bucket after it began and reports come every
// trafficEvery, so the cap is reached only if ticks come faster.
const maxHeld = int(traffic.Span/trafficEvery) + 2

func startTraffic(st *state.Store, node, relay string) *sessionTraffic {
	s := &sessionTraffic{st: st, node: node, relay: relay, lastTry: trafficNow(), stop: make(chan struct{}), done: make(chan struct{})}
	s.ctx, s.cancel = context.WithCancel(context.Background())
	ticks, stopTicks := trafficTicks()
	go func() {
		defer close(s.done)
		defer stopTicks()
		for {
			select {
			case <-ticks:
				ctx, cancel := trafficPeriodic(s.ctx)
				s.report(ctx)
				cancel()
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

// finish stops the ticks, lets sends and receives still returning count, and sends the last report, all within one
// shutdown deadline.
func (s *sessionTraffic) finish() {
	ctx, cancel := trafficShutdown()
	defer cancel()
	defer s.cancel()
	stopAfter := context.AfterFunc(ctx, s.cancel)
	defer stopAfter()
	close(s.stop)
	<-s.done
	if s.metered != nil {
		s.metered.Settle(ctx)
	}
	if ctx.Err() == nil {
		s.report(ctx)
	}
}

func (s *sessionTraffic) report(ctx context.Context) {
	now := trafficNow()
	gap := now.mono - s.lastTry.mono
	if step := now.wall.Sub(s.lastTry.wall) - gap; gap >= traffic.Span || step > clockStep || step < -clockStep {
		// Where the pending bytes belong is unknown: reports stalled for a bucket or more, or the wall clock stepped
		// since the last report. They are dropped, never sent.
		s.sentIn, s.sentOut, s.held, s.lastTry = s.in.Load(), s.out.Load(), nil, now
		return
	}
	for len(s.held) > 0 && (age(s.held[0].since, now) >= traffic.Span || len(s.held) >= maxHeld) {
		// Dropped: counted now, they would land in a later bucket than the one they crossed the relay in.
		s.sentIn, s.sentOut, s.held = s.sentIn+s.held[0].in, s.sentOut+s.held[0].out, s.held[1:]
	}
	in, out := min(s.in.Load()-s.sentIn, daemon.MaxTrafficCount), min(s.out.Load()-s.sentOut, daemon.MaxTrafficCount)
	since := s.lastTry
	s.lastTry = now
	if in == 0 && out == 0 {
		return
	}
	kept, err := sendReport(ctx, s.st, daemon.TrafficReport{Op: "traffic.report", Node: s.node, Relay: s.relay, In: in, Out: out})
	if kept {
		var heldIn, heldOut uint64
		for _, b := range s.held {
			heldIn, heldOut = heldIn+b.in, heldOut+b.out
		}
		if b := (heldBatch{in: in - min(in, heldIn), out: out - min(out, heldOut), since: since}); b.in != 0 || b.out != 0 {
			s.held = append(s.held, b)
		}
	} else {
		s.sentIn, s.sentOut, s.held = s.sentIn+in, s.sentOut+out, nil
	}
	if trafficReported != nil {
		trafficReported(err)
	}
}

// age is how long ago since was by whichever clock says longer, so a batch is never kept past a bucket by either.
func age(since, now clockReading) time.Duration {
	return max(now.mono-since.mono, now.wall.Sub(since.wall))
}

// sendReport sends one report and reads its answer before ctx ends. kept is true when the daemon did not count the
// bytes: the line never reached it whole, or it refused the report (an older daemon does not know the op).
func sendReport(ctx context.Context, st *state.Store, r daemon.TrafficReport) (kept bool, err error) {
	var d net.Dialer
	c, err := d.DialContext(ctx, "unix", daemon.SocketPath(st))
	if err != nil {
		return true, err
	}
	defer c.Close()
	stop := context.AfterFunc(ctx, func() { c.Close() })
	defer stop()
	if deadline, ok := ctx.Deadline(); ok {
		if err := c.SetDeadline(deadline); err != nil {
			return true, err
		}
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
