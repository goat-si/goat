package cli

import (
	"bytes"
	"context"
	"errors"
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
	// cut drops a's uplink, which ends its sessions the way a relay can: with no FIN.
	cut func()
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
	f.cut = func() {
		if !rs.DropUplink(aid.NodeID()) {
			t.Error("a has no uplink to drop")
		}
	}
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

func TestForwardResetsTheLocalClientWhenTheRelayCutsTheStream(t *testing.T) {
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
		c.Write([]byte("partial"))
		io.Copy(io.Discard, c)
		c.Close()
	}()
	f := startForward(t, svc)

	c := dialTCP(t, f.addr)
	defer c.Close()
	if _, err := io.ReadFull(c, make([]byte, len("partial"))); err != nil {
		t.Fatal(err)
	}
	f.cut()
	if _, err := c.Read(make([]byte, 1)); err == nil || errors.Is(err, io.EOF) {
		t.Fatalf("the local client read %v after the relay cut its stream; want a reset, not the end of the stream", err)
	}
}
