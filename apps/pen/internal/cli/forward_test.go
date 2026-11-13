package cli

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
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
	// b is the forwarding member's state directory; rs the relay and aNode a's node id.
	b     *state.Store
	rs    *relaytest.Server
	aNode string
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
	f := &forwardFixture{addr: ln.Addr().String(), connDone: make(chan struct{}, 1), b: b, rs: rs, aNode: aid.NodeID()}
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

// A daemon that still runs after this node was revoked (a leave no member took leaves it so) sends
// the revoke in the watch's first line; a forward then announces nothing and a pipe opens nothing.
func TestForwardAndPipeDoNotStartForANodeAlreadyRevoked(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	_, b := meshOfTwo(t, ctx, rs)
	revokedHere := tmpStore(t) // b's identity and mesh, behind a daemon whose view revokes b
	copyNodeFiles(t, b, revokedHere)
	p, err := loadPeer(revokedHere)
	if err != nil {
		t.Fatal(err)
	}
	first, err := json.Marshal(daemon.WatchLine{T: "view", Revoked: []daemon.NameRef{{NodeID: p.id.NodeID(), Name: "b"}}})
	if err != nil {
		t.Fatal(err)
	}
	ctl, err := net.Listen("unix", daemon.SocketPath(revokedHere))
	if err != nil {
		t.Fatal(err)
	}
	defer ctl.Close()
	go func() {
		for {
			c, err := ctl.Accept()
			if err != nil {
				return
			}
			bufio.NewReader(c).ReadString('\n')
			c.Write(append(first, '\n'))
			defer c.Close()
		}
	}()
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
	go func() {
		code <- runForward(ctx, ln, revokedHere, p, m, 9, outW, &errOut, nil)
		outW.Close()
	}()
	if line, _ := bufio.NewReader(out).ReadString('\n'); line != "" {
		t.Fatalf("a revoked node announced a forward: %q", line)
	}
	if got := <-code; got == 0 || !strings.Contains(errOut.String(), "nothing was opened") {
		t.Fatalf("forward exit %d, stderr %q; want a refusal before it serves", got, errOut.String())
	}
	if c, err := net.Dial("tcp", ln.Addr().String()); err == nil {
		c.Close()
		t.Fatal("the forward that did not start still holds its port")
	}

	t.Setenv("PEN_HOME", revokedHere.Dir)
	Stdin = strings.NewReader("")
	defer func() { Stdin = os.Stdin }()
	errOut.Reset()
	if got := RunPipe([]string{"a", "9"}, io.Discard, &errOut); got == 0 || !strings.Contains(errOut.String(), "nothing was opened") {
		t.Fatalf("pipe exit %d, stderr %q; want a refusal before any open", got, errOut.String())
	}
}

// copyNodeFiles copies the files a node's identity and mesh are made of from a store whose daemon runs. It holds the
// source's state lock, under which the daemon replaces config.json and mesh.json, so a read never meets a replace:
// on Windows that read fails with a sharing violation. The daemon's own runtime files (daemon.json, written without
// the lock) are not copied.
func copyNodeFiles(t *testing.T, from, to *state.Store) {
	t.Helper()
	unlock, err := from.Lock()
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	for _, name := range []string{"identity.json", "config.json", "mesh.json"} {
		data, err := os.ReadFile(from.Path(name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(to.Path(name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}
