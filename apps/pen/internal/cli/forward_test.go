package cli

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"net"
	"strings"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

// forwardFixture runs member a with a service on svc and pen forward on member b toward a's svc port.
type forwardFixture struct {
	addr     string
	connDone chan struct{}
	stderr   bytes.Buffer
	stop     func() int
}

func startForward(t *testing.T, svc net.Listener) *forwardFixture {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	rs := relaytest.New()
	t.Cleanup(rs.Close)
	a := tmpStore(t)
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
	b := tmpStore(t)
	bid, _, _ := b.EnsureIdentity()
	b.SaveConfig(state.Config{Relay: rs.URL, Name: "b"})
	s, err := daemon.Join(ctx, b, bid, tok, "b")
	if err != nil {
		t.Fatal(err)
	}
	s.Save()
	startNode(t, ctx, rs, b)

	p, err := loadPeer(b)
	if err != nil {
		t.Fatal(err)
	}
	m, err := Resolve(p.view.SortedMembers(), "a")
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &forwardFixture{addr: ln.Addr().String(), connDone: make(chan struct{}, 1)}
	fctx, fcancel := context.WithCancel(ctx)
	code := make(chan int, 1)
	go func() {
		code <- runForward(fctx, ln, b, p, m, svc.Addr().(*net.TCPAddr).Port, io.Discard, &f.stderr, func() { f.connDone <- struct{}{} })
	}()
	f.stop = func() int { fcancel(); return <-code }
	return f
}

// resetClose closes c with SO_LINGER 0, so the peer gets RST instead of FIN.
func resetClose(t *testing.T, c *net.TCPConn) {
	t.Helper()
	if err := c.SetLinger(0); err != nil {
		t.Fatal(err)
	}
	c.Close()
}

func dialTCP(t *testing.T, addr string) *net.TCPConn {
	t.Helper()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	return c.(*net.TCPConn)
}

func assertQuiet(t *testing.T, f *forwardFixture) {
	t.Helper()
	<-f.connDone
	if code := f.stop(); code != 0 {
		t.Fatalf("forward exit %d", code)
	}
	if strings.Contains(f.stderr.String(), "pen forward:") {
		t.Fatalf("a local client that went away was reported as an error: %q", f.stderr.String())
	}
}

func TestForwardIsQuietWhenTheLocalClientResetsAfterItsReply(t *testing.T) {
	svc, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close()
	go func() {
		c, err := svc.Accept()
		if err != nil {
			return
		}
		io.Copy(c, c)
		c.Close()
	}()
	f := startForward(t, svc)

	c := dialTCP(t, f.addr)
	if _, err := c.Write([]byte("hi")); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(c, reply); err != nil || string(reply) != "hi" {
		t.Fatalf("reply %q, %v", reply, err)
	}
	resetClose(t, c)
	assertQuiet(t, f)
}

func TestForwardIsQuietWhenTheServiceClosesAfterTheLocalClientIsGone(t *testing.T) {
	svc, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close()
	sawEOF, closeNow := make(chan struct{}), make(chan struct{})
	go func() {
		c, err := svc.Accept()
		if err != nil {
			return
		}
		io.Copy(io.Discard, c)
		close(sawEOF)
		<-closeNow
		c.Close()
	}()
	f := startForward(t, svc)

	c := dialTCP(t, f.addr)
	if _, err := c.Write([]byte("hi")); err != nil {
		t.Fatal(err)
	}
	if err := c.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	<-sawEOF
	resetClose(t, c)
	close(closeNow)
	assertQuiet(t, f)
}

func TestForwardStopsWhenThisNodeLeavesTheMesh(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	_, b := meshOfTwo(t, ctx, rs)
	p, err := loadPeer(b)
	if err != nil {
		t.Fatal(err)
	}
	m, err := Resolve(p.view.SortedMembers(), "a")
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var errOut bytes.Buffer
	code := make(chan int, 1)
	out, outW := io.Pipe()
	go func() { code <- runForward(ctx, ln, b, p, m, 9, outW, &errOut, nil) }()
	// The forward says it is forwarding only once the daemon holds its watch, so the leave comes after.
	if _, err := bufio.NewReader(out).ReadString('\n'); err != nil {
		t.Fatal(err)
	}
	var res struct{ Results []daemon.PushResult }
	if err := daemon.Call(b, daemon.Request{Op: "leave"}, &res); err != nil {
		t.Fatal(err)
	}
	// A forward left running after pen leave would keep the port and a key the mesh refuses.
	if got := <-code; got != 255 || !strings.Contains(errOut.String(), "left the mesh") {
		t.Fatalf("forward exit %d, stderr %q; want 255 and a line saying this node left", got, errOut.String())
	}
	if c, err := net.Dial("tcp", ln.Addr().String()); err == nil {
		c.Close()
		t.Fatal("the forward still listens after this node left")
	}
}

// A daemon that takes the watch but hangs up before its first line (it is stopping, perhaps for a
// leave) leaves the forward unable to learn of a revocation, so the forward does not start.
func TestForwardDoesNotStartWhenTheDaemonDropsItsWatch(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	_, b := meshOfTwo(t, ctx, rs)
	p, err := loadPeer(b)
	if err != nil {
		t.Fatal(err)
	}
	m, err := Resolve(p.view.SortedMembers(), "a")
	if err != nil {
		t.Fatal(err)
	}
	dropping := tmpStore(t)
	ctl, err := net.Listen("unix", daemon.SocketPath(dropping))
	if err != nil {
		t.Fatal(err)
	}
	defer ctl.Close()
	go func() {
		c, err := ctl.Accept()
		if err != nil {
			return
		}
		bufio.NewReader(c).ReadString('\n')
		c.Close()
	}()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var errOut bytes.Buffer
	code := make(chan int, 1)
	out, outW := io.Pipe()
	go func() {
		code <- runForward(ctx, ln, dropping, p, m, 9, outW, &errOut, nil)
		outW.Close()
	}()
	if line, _ := bufio.NewReader(out).ReadString('\n'); line != "" {
		t.Fatalf("the forward started without its watch: %q", line)
	}
	if got := <-code; got == 0 || !strings.Contains(errOut.String(), "daemon") {
		t.Fatalf("forward exit %d, stderr %q; want a failure naming the daemon", got, errOut.String())
	}
	if c, err := net.Dial("tcp", ln.Addr().String()); err == nil {
		c.Close()
		t.Fatal("the forward that did not start still holds its port")
	}
}

// A pen leave that finishes between loading the peer and starting the watch deletes this node's
// identity and stops the daemon; with no daemon to watch, the forward checks and does not start.
func TestForwardDoesNotStartAfterThisNodeLeftWhileItLoaded(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	_, b := meshOfTwo(t, ctx, rs)
	p, err := loadPeer(b)
	if err != nil {
		t.Fatal(err)
	}
	m, err := Resolve(p.view.SortedMembers(), "a")
	if err != nil {
		t.Fatal(err)
	}
	left := tmpStore(t) // what the leave leaves behind: no identity and no daemon
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var errOut bytes.Buffer
	code := make(chan int, 1)
	out, outW := io.Pipe()
	go func() {
		code <- runForward(ctx, ln, left, p, m, 9, outW, &errOut, nil)
		outW.Close()
	}()
	if line, _ := bufio.NewReader(out).ReadString('\n'); line != "" {
		t.Fatalf("the forward started for a node that left: %q", line)
	}
	if got := <-code; got == 0 || !strings.Contains(errOut.String(), "left the mesh") {
		t.Fatalf("forward exit %d, stderr %q; want a failure saying this node left", got, errOut.String())
	}
	if c, err := net.Dial("tcp", ln.Addr().String()); err == nil {
		c.Close()
		t.Fatal("the forward that did not start still holds its port")
	}
}
