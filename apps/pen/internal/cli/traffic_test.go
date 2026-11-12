package cli

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/state"
	"github.com/goat-si/goat/apps/pen/internal/traffic"
)

// trafficOf reads st's pen ls as JSON and returns traffic24h of the member called name (nil when absent).
func trafficOf(t *testing.T, st *state.Store, name string) map[string]any {
	t.Helper()
	var raw map[string]any
	if err := daemon.Call(st, daemon.Request{Op: "ls"}, &raw); err != nil {
		t.Fatal(err)
	}
	for _, m := range raw["members"].([]any) {
		if mm := m.(map[string]any); mm["name"] == name {
			tr, _ := mm["traffic24h"].(map[string]any)
			return tr
		}
	}
	t.Fatalf("no member %q", name)
	return nil
}

func wantTraffic(t *testing.T, what string, tr map[string]any, in, out int) {
	t.Helper()
	if tr == nil {
		t.Fatalf("%s: no traffic24h, want in %d out %d", what, in, out)
	}
	if tr["in"] != float64(in) || tr["out"] != float64(out) {
		t.Fatalf("%s: in %v out %v, want in %d out %d", what, tr["in"], tr["out"], in, out)
	}
}

// sink accepts one connection, reads it to its end, then writes reply bytes and closes.
func sink(t *testing.T, reply int) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		io.Copy(io.Discard, c)
		c.Write(make([]byte, reply))
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

// signalWriter collects bytes; wait returns once it holds n.
type signalWriter struct {
	mu   sync.Mutex
	cond *sync.Cond
	n    int
}

func newSignalWriter() *signalWriter {
	w := &signalWriter{}
	w.cond = sync.NewCond(&w.mu)
	return w
}

func (w *signalWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	w.n += len(p)
	w.mu.Unlock()
	w.cond.Broadcast()
	return len(p), nil
}

func (w *signalWriter) wait(n int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for w.n < n {
		w.cond.Wait()
	}
}

func TestPipeReportsTheBytesItSplicedInEachDirection(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a, b := meshOfTwo(t, ctx, rs)
	const sent, received = 200_000, 300_001
	port := sink(t, received)

	t.Setenv("PEN_HOME", b.Dir)
	Stdin = bytes.NewReader(make([]byte, sent))
	defer func() { Stdin = os.Stdin }()
	var out, errOut bytes.Buffer
	if code := RunPipe([]string{"a", strconv.Itoa(port)}, &out, &errOut); code != 0 || out.Len() != received {
		t.Fatalf("pipe exit %d with %d bytes out, stderr %q", code, out.Len(), errOut.String())
	}
	tr := trafficOf(t, b, "a")
	wantTraffic(t, "b's count for a (pen pipe)", tr, received, sent)
	if relays, _ := tr["relays"].([]any); len(relays) != 1 || relays[0].(map[string]any)["url"] != rs.URL {
		t.Fatalf("relays %v, want the one relay the pipe used", tr["relays"])
	}
	wantTraffic(t, "a's count for b (accepted session)", trafficOf(t, a, "b"), sent, received)
}

func TestPipeReportsTheBytesOfASessionTheRelayCut(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a, b := meshOfTwo(t, ctx, rs)
	const sent = 1000
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	serverGot := make(chan struct{})
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		c.Write([]byte("partial"))
		io.ReadFull(c, make([]byte, sent))
		close(serverGot)
		io.Copy(io.Discard, c)
	}()

	t.Setenv("PEN_HOME", b.Dir)
	in, inW := io.Pipe()
	defer inW.Close()
	Stdin = in
	defer func() { Stdin = os.Stdin }()
	out := newSignalWriter()
	var errOut bytes.Buffer
	code := make(chan int, 1)
	go func() { code <- RunPipe([]string{"a", strconv.Itoa(ln.Addr().(*net.TCPAddr).Port)}, out, &errOut) }()
	go inW.Write(make([]byte, sent))
	<-serverGot
	out.wait(len("partial"))
	aid, err := a.LoadIdentity()
	if err != nil {
		t.Fatal(err)
	}
	if !rs.DropUplink(aid.NodeID()) {
		t.Fatal("a has no uplink to drop")
	}
	if got := <-code; got == 0 {
		t.Fatalf("pipe exit 0 after the relay cut its session; stderr %q", errOut.String())
	}
	wantTraffic(t, "b's count for a after the cut", trafficOf(t, b, "a"), len("partial"), sent)
}

// setTrafficHooks makes sessions tick on ticks and tells reported the result of each report.
func setTrafficHooks(t *testing.T, ticks chan time.Time, reported func(error)) {
	t.Helper()
	oldTicks, oldReported := trafficTicks, trafficReported
	t.Cleanup(func() { trafficTicks, trafficReported = oldTicks, oldReported })
	trafficTicks = func() (<-chan time.Time, func()) { return ticks, func() {} }
	trafficReported = reported
	oldPeriodic := trafficPeriodic
	t.Cleanup(func() { trafficPeriodic = oldPeriodic })
	trafficPeriodic = func(ctx context.Context) (context.Context, context.CancelFunc) { return context.WithCancel(ctx) }
}

func TestPipeReportsWhileItRunsAndCountsNothingTwice(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a, b := meshOfTwo(t, ctx, rs)
	_ = a
	ticks := make(chan time.Time)
	reported := make(chan error, 8)
	setTrafficHooks(t, ticks, func(err error) { reported <- err })
	port := echoPort(t)

	t.Setenv("PEN_HOME", b.Dir)
	in, inW := io.Pipe()
	defer inW.Close()
	Stdin = in
	defer func() { Stdin = os.Stdin }()
	out := newSignalWriter()
	var errOut bytes.Buffer
	code := make(chan int, 1)
	go func() { code <- RunPipe([]string{"a", strconv.Itoa(port)}, out, &errOut) }()
	if _, err := inW.Write(make([]byte, 100)); err != nil {
		t.Fatal(err)
	}
	out.wait(100)
	ticks <- time.Now()
	if err := <-reported; err != nil {
		t.Fatalf("interval report: %v", err)
	}
	wantTraffic(t, "while the pipe runs", trafficOf(t, b, "a"), 100, 100)
	inW.Close()
	if got := <-code; got != 0 {
		t.Fatalf("pipe exit %d, stderr %q", got, errOut.String())
	}
	wantTraffic(t, "after the pipe ended", trafficOf(t, b, "a"), 100, 100)
}

func echoPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				io.Copy(c, c)
				c.(*net.TCPConn).CloseWrite()
				c.Close()
			}()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

// founderAndJoiner runs a's daemon and joins b without starting b's.
func founderAndJoiner(t *testing.T, ctx context.Context, rs *relaytest.Server) (a, b *state.Store) {
	t.Helper()
	a = tmpStore(t)
	aid, _, _ := a.EnsureIdentity()
	a.SaveConfig(state.Config{Relay: rs.URL, Name: "a"})
	if _, err := mesh.Found(a, aid, "a", 1); err != nil {
		t.Fatal(err)
	}
	startNode(t, ctx, rs, a)
	var inv struct{ Token string }
	if err := daemon.Call(a, daemon.Request{Op: "invite", TTLMs: 60000}, &inv); err != nil {
		t.Fatal(err)
	}
	tok, _ := mesh.ParseToken(inv.Token)
	b = tmpStore(t)
	bid, _, _ := b.EnsureIdentity()
	b.SaveConfig(state.Config{Relay: rs.URL, Name: "b"})
	s, err := daemon.Join(ctx, b, bid, tok, "b")
	if err != nil {
		t.Fatal(err)
	}
	s.Save()
	return a, b
}

// fakeDaemon answers watch like a daemon and every other op with answer; an empty answer hangs up instead.
func fakeDaemon(t *testing.T, st *state.Store, answer string) {
	t.Helper()
	fakeDaemonFunc(t, st, func([]byte) string { return answer })
}

// fakeDaemonFunc answers watch like a daemon and every other request line with answer(line).
func fakeDaemonFunc(t *testing.T, st *state.Store, answer func(line []byte) string) {
	t.Helper()
	ln, err := net.Listen("unix", daemon.SocketPath(st))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				line, err := bufio.NewReader(c).ReadBytes('\n')
				if err != nil {
					return
				}
				var req struct{ Op string }
				json.Unmarshal(line, &req)
				if req.Op == "watch" {
					c.Write([]byte(`{"t":"view","at":0,"members":[],"revoked":[]}` + "\n"))
					io.Copy(io.Discard, c)
					return
				}
				switch a := answer(line); a {
				case "":
				case "hold":
					io.Copy(io.Discard, c)
				default:
					c.Write([]byte(a + "\n"))
				}
			}()
		}
	}()
}

func TestPipeIsUnchangedWhenItsTrafficReportFails(t *testing.T) {
	for _, tc := range []struct{ name, answer string }{
		{"no daemon", "-"},
		{"a daemon that does not know the op", `{"error":"unknown op \"traffic.report\""}`},
		{"a report the daemon drops without an answer", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			rs := relaytest.New()
			defer rs.Close()
			_, b := founderAndJoiner(t, ctx, rs)
			if tc.answer != "-" {
				fakeDaemon(t, b, tc.answer)
			}
			var mu sync.Mutex
			var results []error
			setTrafficHooks(t, make(chan time.Time), func(err error) {
				mu.Lock()
				results = append(results, err)
				mu.Unlock()
			})
			port := echoPort(t)
			t.Setenv("PEN_HOME", b.Dir)
			msg := bytes.Repeat([]byte("x"), 5000)
			Stdin = bytes.NewReader(msg)
			defer func() { Stdin = os.Stdin }()
			var out, errOut bytes.Buffer
			code := RunPipe([]string{"a", strconv.Itoa(port)}, &out, &errOut)
			if code != 0 || !bytes.Equal(out.Bytes(), msg) || errOut.Len() != 0 {
				t.Fatalf("pipe exit %d, %d bytes out, stderr %q; want 0, the echo, and nothing on stderr", code, out.Len(), errOut.String())
			}
			mu.Lock()
			defer mu.Unlock()
			if len(results) != 1 || results[0] == nil {
				t.Fatalf("report results %v, want one failed report", results)
			}
		})
	}
}

func TestForwardReportsTheBytesOfEachConnection(t *testing.T) {
	svc, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close()
	const sent, received = 70_000, 9
	go func() {
		c, err := svc.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		io.Copy(io.Discard, c)
		c.Write(make([]byte, received))
	}()
	f := startForward(t, svc)
	c := dialTCP(t, f.addr)
	defer c.Close()
	c.Write(make([]byte, sent))
	c.CloseWrite()
	if n, _ := io.Copy(io.Discard, c); n != received {
		t.Fatalf("read %d bytes, want %d", n, received)
	}
	<-f.connDone
	wantTraffic(t, "b's count for a (pen forward)", trafficOf(t, f.b, "a"), received, sent)
}

// A daemon that counted a report but whose answer was lost must not be sent the same bytes again: the reporter keeps
// bytes only when it knows they were not counted.
func TestPipeDoesNotReportBytesTwiceWhenAnAnswerIsLost(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	_, b := founderAndJoiner(t, ctx, rs)
	var mu sync.Mutex
	var reports []daemon.TrafficReport
	fakeDaemonFunc(t, b, func(line []byte) string {
		var r daemon.TrafficReport
		json.Unmarshal(line, &r)
		mu.Lock()
		defer mu.Unlock()
		reports = append(reports, r)
		if len(reports) == 1 {
			return ""
		}
		return `{"t":"counted"}`
	})
	ticks := make(chan time.Time)
	reported := make(chan error, 8)
	setTrafficHooks(t, ticks, func(err error) { reported <- err })
	port := echoPort(t)

	t.Setenv("PEN_HOME", b.Dir)
	in, inW := io.Pipe()
	defer inW.Close()
	Stdin = in
	defer func() { Stdin = os.Stdin }()
	out := newSignalWriter()
	var errOut bytes.Buffer
	code := make(chan int, 1)
	go func() { code <- RunPipe([]string{"a", strconv.Itoa(port)}, out, &errOut) }()
	inW.Write(make([]byte, 100))
	out.wait(100)
	ticks <- time.Now()
	if err := <-reported; err == nil {
		t.Fatal("the report whose answer was dropped succeeded")
	}
	inW.Write(make([]byte, 50))
	out.wait(150)
	inW.Close()
	if got := <-code; got != 0 {
		t.Fatalf("pipe exit %d, stderr %q", got, errOut.String())
	}
	mu.Lock()
	defer mu.Unlock()
	var sumIn, sumOut uint64
	for _, r := range reports {
		sumIn += r.In
		sumOut += r.Out
	}
	if len(reports) != 2 || sumIn != 150 || sumOut != 150 {
		t.Fatalf("reports %+v sum to in %d out %d; want two reports summing to the 150 bytes each way the pipe carried", reports, sumIn, sumOut)
	}
}

// Stopping pen forward must not drop the last report of a connection still open: the command waits for its
// connections to end and report before it returns.
func TestStoppingForwardReportsItsOpenConnections(t *testing.T) {
	svc, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close()
	const sent = 40_000
	got := make(chan struct{})
	go func() {
		c, err := svc.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		io.ReadFull(c, make([]byte, sent))
		close(got)
		io.Copy(io.Discard, c)
	}()
	f := startForward(t, svc)
	c := dialTCP(t, f.addr)
	defer c.Close()
	c.Write(make([]byte, sent))
	<-got
	if code := f.stop(); code != 0 {
		t.Fatalf("forward exit %d", code)
	}
	wantTraffic(t, "b's count for a right after pen forward stopped", trafficOf(t, f.b, "a"), 0, sent)
	if strings.Contains(f.stderr.String(), "pen forward:") {
		t.Fatalf("stopping pen forward with an open connection printed an error: %q", f.stderr.String())
	}
}

// A forward stopped while a connection is still opening its session is no error either.
func TestStoppingForwardDuringASessionOpenIsQuiet(t *testing.T) {
	svc, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close()
	f := startForward(t, svc)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// a's answer (message 2) waits at the relay, so the open is still pending when the forward stops.
	f.rs.DrainClientMessages(f.aNode)
	release := f.rs.HoldNextUplinkMessage()
	defer release()
	c := dialTCP(t, f.addr)
	defer c.Close()
	if err := f.rs.NextClientMessage(ctx, f.aNode); err != nil {
		t.Fatal(err)
	}
	if code := f.stop(); code != 0 {
		t.Fatalf("forward exit %d", code)
	}
	if strings.Contains(f.stderr.String(), "pen forward:") {
		t.Fatalf("stopping pen forward while a session was opening printed an error: %q", f.stderr.String())
	}
}

// holdingDaemon answers watch like a daemon and holds every other request unanswered until its connection closes;
// got receives each request line it holds.
func holdingDaemon(t *testing.T, st *state.Store) <-chan []byte {
	t.Helper()
	got := make(chan []byte, 8)
	fakeDaemonFunc(t, st, func(line []byte) string {
		got <- line
		return "hold"
	})
	return got
}

// pen pipe is ssh's ProxyCommand: when the daemon takes reports and never answers, the whole end of the session (the
// periodic report in flight, settling the meter and the last report) must end at one shutdown deadline.
func TestPipeShutdownEndsAtOneDeadlineWhenTheDaemonHoldsItsAnswers(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	_, b := founderAndJoiner(t, ctx, rs)
	got := holdingDaemon(t, b)
	ticks := make(chan time.Time)
	setTrafficHooks(t, ticks, nil)
	shutdown, endShutdown := context.WithCancel(context.Background())
	oldShutdown := trafficShutdown
	t.Cleanup(func() { trafficShutdown = oldShutdown })
	trafficShutdown = func() (context.Context, context.CancelFunc) { return shutdown, func() {} }
	port := echoPort(t)

	t.Setenv("PEN_HOME", b.Dir)
	in, inW := io.Pipe()
	defer inW.Close()
	Stdin = in
	defer func() { Stdin = os.Stdin }()
	out := newSignalWriter()
	var errOut bytes.Buffer
	code := make(chan int, 1)
	go func() { code <- RunPipe([]string{"a", strconv.Itoa(port)}, out, &errOut) }()
	inW.Write(make([]byte, 100))
	out.wait(100)
	ticks <- time.Now()
	<-got
	// More bytes after the periodic report took its count, so the end has a report of its own to send.
	inW.Write(make([]byte, 50))
	out.wait(150)
	inW.Close()
	endShutdown()
	if c := <-code; c != 0 || errOut.Len() != 0 {
		t.Fatalf("pipe exit %d, stderr %q; want 0 and nothing", c, errOut.String())
	}
}

// Bytes a report certainly did not deliver wait at most one bucket: after that they are dropped, so a daemon that
// comes back never receives old bytes as new ones.
func TestPipeDropsBytesTheDaemonDidNotTakeWithinOneBucket(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	_, b := founderAndJoiner(t, ctx, rs)
	var mu sync.Mutex
	var reports []daemon.TrafficReport
	fakeDaemonFunc(t, b, func(line []byte) string {
		var r daemon.TrafficReport
		json.Unmarshal(line, &r)
		mu.Lock()
		defer mu.Unlock()
		reports = append(reports, r)
		if len(reports) == 1 {
			return `{"error":"unknown op \"traffic.report\""}`
		}
		return `{"t":"counted"}`
	})
	start := time.Unix(1_800_000_000, 0)
	set := testClock(t)
	set(start, 0)
	ticks := make(chan time.Time)
	reported := make(chan error, 8)
	setTrafficHooks(t, ticks, func(err error) { reported <- err })
	port := echoPort(t)

	t.Setenv("PEN_HOME", b.Dir)
	in, inW := io.Pipe()
	defer inW.Close()
	Stdin = in
	defer func() { Stdin = os.Stdin }()
	out := newSignalWriter()
	var errOut bytes.Buffer
	code := make(chan int, 1)
	go func() { code <- RunPipe([]string{"a", strconv.Itoa(port)}, out, &errOut) }()
	inW.Write(make([]byte, 100))
	out.wait(100)
	set(start.Add(2*time.Minute), 2*time.Minute)
	ticks <- time.Now()
	<-reported // refused: those 100 bytes wait
	inW.Write(make([]byte, 50))
	out.wait(150)
	// The daemon answers again only a bucket after the refused bytes began: they are dropped, not counted now.
	set(start.Add(traffic.Span+time.Minute), traffic.Span+time.Minute)
	ticks <- time.Now()
	if err := <-reported; err != nil {
		t.Fatalf("second report: %v", err)
	}
	inW.Close()
	if c := <-code; c != 0 {
		t.Fatalf("pipe exit %d, stderr %q", c, errOut.String())
	}
	mu.Lock()
	defer mu.Unlock()
	if len(reports) != 2 || reports[1].In != 50 || reports[1].Out != 50 {
		t.Fatalf("reports %+v; want the counted second report to carry only the 50 new bytes each way", reports)
	}
}

func TestPipeShutdownEndsAtOneDeadlineWhenTheDaemonHoldsTheLastReport(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	_, b := founderAndJoiner(t, ctx, rs)
	got := holdingDaemon(t, b)
	setTrafficHooks(t, make(chan time.Time), nil)
	shutdown, endShutdown := context.WithCancel(context.Background())
	oldShutdown := trafficShutdown
	t.Cleanup(func() { trafficShutdown = oldShutdown })
	trafficShutdown = func() (context.Context, context.CancelFunc) { return shutdown, func() {} }
	port := echoPort(t)

	t.Setenv("PEN_HOME", b.Dir)
	msg := bytes.Repeat([]byte("x"), 300)
	Stdin = bytes.NewReader(msg)
	defer func() { Stdin = os.Stdin }()
	var out, errOut bytes.Buffer
	code := make(chan int, 1)
	go func() { code <- RunPipe([]string{"a", strconv.Itoa(port)}, &out, &errOut) }()
	<-got // the last report reached the daemon, which holds it
	endShutdown()
	if c := <-code; c != 0 || !bytes.Equal(out.Bytes(), msg) || errOut.Len() != 0 {
		t.Fatalf("pipe exit %d, %d bytes out, stderr %q; want 0, the echo and nothing", c, out.Len(), errOut.String())
	}
}

// Held bytes age by the refused report that carried them: when an old batch is dropped, a newer one still in its
// bucket is counted.
func TestPipeKeepsNewerRefusedBytesWhenAnOlderBatchExpires(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	_, b := founderAndJoiner(t, ctx, rs)
	var mu sync.Mutex
	var reports []daemon.TrafficReport
	fakeDaemonFunc(t, b, func(line []byte) string {
		var r daemon.TrafficReport
		json.Unmarshal(line, &r)
		mu.Lock()
		defer mu.Unlock()
		reports = append(reports, r)
		if len(reports) <= 2 {
			return `{"error":"unknown op \"traffic.report\""}`
		}
		return `{"t":"counted"}`
	})
	start := time.Unix(1_800_000_000, 0)
	set := testClock(t)
	set(start, 0)
	ticks := make(chan time.Time)
	reported := make(chan error, 8)
	setTrafficHooks(t, ticks, func(err error) { reported <- err })
	port := echoPort(t)

	t.Setenv("PEN_HOME", b.Dir)
	in, inW := io.Pipe()
	defer inW.Close()
	Stdin = in
	defer func() { Stdin = os.Stdin }()
	out := newSignalWriter()
	var errOut bytes.Buffer
	code := make(chan int, 1)
	go func() { code <- RunPipe([]string{"a", strconv.Itoa(port)}, out, &errOut) }()
	inW.Write(make([]byte, 100))
	out.wait(100)
	set(start.Add(2*time.Minute), 2*time.Minute)
	ticks <- time.Now()
	<-reported // refused: 100 bytes from the start
	inW.Write(make([]byte, 50))
	out.wait(150)
	set(start.Add(14*time.Minute), 14*time.Minute)
	ticks <- time.Now()
	<-reported // refused: 150, of which 50 from +2 min
	set(start.Add(16*time.Minute), 16*time.Minute)
	ticks <- time.Now() // the daemon is back; the batch from the start is a bucket old
	inW.Close()
	if c := <-code; c != 0 {
		t.Fatalf("pipe exit %d, stderr %q", c, errOut.String())
	}
	mu.Lock()
	defer mu.Unlock()
	if len(reports) != 3 || reports[2].In != 50 || reports[2].Out != 50 {
		t.Fatalf("reports %+v; want a third report counting the 50 bytes each way from +2 min", reports)
	}
}

// A session whose reports stalled for a bucket or more (its machine slept, or the clock jumped) cannot tell when in
// that time its bytes moved: they are dropped, not counted in the current bucket.
func TestPipeDropsBytesWhoseReportCameABucketLate(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	_, b := founderAndJoiner(t, ctx, rs)
	var mu sync.Mutex
	var reports []daemon.TrafficReport
	fakeDaemonFunc(t, b, func(line []byte) string {
		var r daemon.TrafficReport
		json.Unmarshal(line, &r)
		mu.Lock()
		defer mu.Unlock()
		reports = append(reports, r)
		return `{"t":"counted"}`
	})
	start := time.Unix(1_800_000_000, 0)
	set := testClock(t)
	set(start, 0)
	ticks := make(chan time.Time)
	setTrafficHooks(t, ticks, nil)
	port := echoPort(t)

	t.Setenv("PEN_HOME", b.Dir)
	in, inW := io.Pipe()
	defer inW.Close()
	Stdin = in
	defer func() { Stdin = os.Stdin }()
	out := newSignalWriter()
	var errOut bytes.Buffer
	code := make(chan int, 1)
	go func() { code <- RunPipe([]string{"a", strconv.Itoa(port)}, out, &errOut) }()
	inW.Write(make([]byte, 100))
	out.wait(100)
	set(start.Add(traffic.Span+time.Minute), traffic.Span+time.Minute)
	ticks <- time.Now() // the first report comes a bucket late
	ticks <- time.Now() // taken only once the late report has finished
	inW.Write(make([]byte, 50))
	out.wait(150)
	inW.Close()
	if c := <-code; c != 0 {
		t.Fatalf("pipe exit %d, stderr %q", c, errOut.String())
	}
	mu.Lock()
	defer mu.Unlock()
	var sumIn, sumOut uint64
	for _, r := range reports {
		sumIn, sumOut = sumIn+r.In, sumOut+r.Out
	}
	if sumIn != 50 || sumOut != 50 {
		t.Fatalf("reports %+v; want only the 50 bytes each way that moved after the late tick", reports)
	}
}

// The daemon buckets bytes by the wall clock, so the reporter ages them by the wall clock too. A time with a monotonic
// reading would measure elapsed time instead, which on Linux stops while the machine sleeps and ignores clock jumps.
func TestTheReportClockIsTheWallClock(t *testing.T) {
	if s := trafficNow().wall.String(); strings.Contains(s, " m=") {
		t.Fatalf("trafficNow() = %s carries a monotonic reading", s)
	}
}

// testClock makes the report clock the test's: set moves its wall and monotonic readings independently.
func testClock(t *testing.T) (set func(wall time.Time, mono time.Duration)) {
	t.Helper()
	var mu sync.Mutex
	var cur clockReading
	old := trafficNow
	t.Cleanup(func() { trafficNow = old })
	trafficNow = func() clockReading {
		mu.Lock()
		defer mu.Unlock()
		return cur
	}
	return func(wall time.Time, mono time.Duration) {
		mu.Lock()
		cur = clockReading{wall: wall, mono: mono}
		mu.Unlock()
	}
}

// After the wall clock is set back, pending bytes cannot be placed in a bucket: they are dropped, never sent, and
// bytes that move after that are counted as usual, through a refused report and its retry.
func TestPipeDropsBytesPendingWhenTheWallClockGoesBack(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	_, b := founderAndJoiner(t, ctx, rs)
	var mu sync.Mutex
	var reports []daemon.TrafficReport
	var counted []uint64
	fakeDaemonFunc(t, b, func(line []byte) string {
		var r daemon.TrafficReport
		json.Unmarshal(line, &r)
		mu.Lock()
		defer mu.Unlock()
		reports = append(reports, r)
		if len(reports) == 2 {
			return `{"error":"unknown op \"traffic.report\""}`
		}
		counted = append(counted, r.In)
		return `{"t":"counted"}`
	})
	noon := time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC)
	set := testClock(t)
	set(noon, 0)
	ticks := make(chan time.Time)
	reported := make(chan error, 8)
	setTrafficHooks(t, ticks, func(err error) { reported <- err })
	port := echoPort(t)

	t.Setenv("PEN_HOME", b.Dir)
	in, inW := io.Pipe()
	defer inW.Close()
	Stdin = in
	defer func() { Stdin = os.Stdin }()
	out := newSignalWriter()
	var errOut bytes.Buffer
	code := make(chan int, 1)
	go func() { code <- RunPipe([]string{"a", strconv.Itoa(port)}, out, &errOut) }()
	inW.Write(make([]byte, 100))
	out.wait(100)
	set(noon.Add(2*time.Minute), 2*time.Minute)
	ticks <- time.Now()
	if err := <-reported; err != nil {
		t.Fatalf("first report: %v", err)
	}
	// The wall clock goes back to 11:58 a minute later; 50 bytes cross at 11:59.
	inW.Write(make([]byte, 50))
	out.wait(150)
	set(noon.Add(-time.Minute), 4*time.Minute)
	ticks <- time.Now()
	ticks <- time.Now() // taken once the report above returned
	inW.Write(make([]byte, 30))
	out.wait(180)
	set(noon.Add(time.Minute), 6*time.Minute)
	ticks <- time.Now()
	if err := <-reported; err == nil {
		t.Fatal("the second report was not refused")
	}
	set(noon.Add(13*time.Minute), 18*time.Minute)
	ticks <- time.Now()
	if err := <-reported; err != nil {
		t.Fatalf("retry: %v", err)
	}
	inW.Close()
	if c := <-code; c != 0 {
		t.Fatalf("pipe exit %d, stderr %q", c, errOut.String())
	}
	mu.Lock()
	defer mu.Unlock()
	if fmt.Sprint(counted) != "[100 30]" {
		t.Fatalf("counted reports carried in %v (all reports %+v); want 100, then the 30 bytes after the clock went back, never the 50 pending across it", counted, reports)
	}
}

// The end of a session runs in two phases on one deadline: it waits for the periodic report in flight, then sends
// the last report, and when the deadline passes while the daemon holds that last answer, the pipe ends.
func TestPipeShutdownWaitsForThePeriodicReportThenEndsTheLastOneOnTheSameDeadline(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	_, b := founderAndJoiner(t, ctx, rs)
	lines := make(chan []byte, 4)
	answers := make(chan string, 4)
	fakeDaemonFunc(t, b, func(line []byte) string {
		lines <- line
		return <-answers
	})
	t.Cleanup(func() { answers <- "" })
	ticks := make(chan time.Time)
	setTrafficHooks(t, ticks, nil)
	shutdown, endShutdown := context.WithCancel(context.Background())
	began := make(chan struct{}, 4)
	oldShutdown := trafficShutdown
	t.Cleanup(func() { trafficShutdown = oldShutdown })
	trafficShutdown = func() (context.Context, context.CancelFunc) {
		began <- struct{}{}
		return shutdown, func() {}
	}
	port := echoPort(t)

	t.Setenv("PEN_HOME", b.Dir)
	in, inW := io.Pipe()
	defer inW.Close()
	Stdin = in
	defer func() { Stdin = os.Stdin }()
	out := newSignalWriter()
	var errOut bytes.Buffer
	code := make(chan int, 1)
	go func() { code <- RunPipe([]string{"a", strconv.Itoa(port)}, out, &errOut) }()
	inW.Write(make([]byte, 100))
	out.wait(100)
	ticks <- time.Now()
	<-lines // the periodic report, held
	inW.Write(make([]byte, 50))
	out.wait(150)
	inW.Close()
	<-began // the end of the session has begun while the periodic report is still held
	answers <- `{"t":"counted"}`
	var last daemon.TrafficReport
	json.Unmarshal(<-lines, &last) // the last report, held
	endShutdown()
	if c := <-code; c != 0 || errOut.Len() != 0 {
		t.Fatalf("pipe exit %d, stderr %q; want 0 and nothing", c, errOut.String())
	}
	if last.In != 50 || last.Out != 50 {
		t.Fatalf("last report %+v, want the 50 bytes each way after the periodic one", last)
	}
	if len(began) != 0 {
		t.Fatal("the end of the session took more than one shutdown deadline")
	}
}
