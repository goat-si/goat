package cli

import (
	"bytes"
	"context"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

// startNode runs a daemon for st against rs and returns once its uplink is registered.
func startNode(t *testing.T, ctx context.Context, rs *relaytest.Server, st *state.Store) {
	t.Helper()
	ready := make(chan struct{})
	d, err := daemon.New(daemon.Options{Store: st, HostKeyGlob: "none", KnownHosts: "none", Ready: func() { close(ready) }, Logf: t.Logf})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- d.Run(ctx) }()
	<-ready
	if err := rs.WaitOnline(ctx, d.NodeID()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Stop(); <-done })
}

func tmpStore(t *testing.T) *state.Store {
	dir, err := os.MkdirTemp("/tmp", "pen")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	st, err := state.OpenDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func TestPipeEndsWith255WhenTheRemoteIsRevoked(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()

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

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	connected := make(chan struct{})
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		close(connected)
		io.Copy(c, c)
		c.Close()
	}()

	t.Setenv("PEN_HOME", b.Dir)
	in, keepOpen := io.Pipe()
	defer keepOpen.Close()
	Stdin = in
	defer func() { Stdin = os.Stdin }()
	var out, errOut bytes.Buffer
	code := make(chan int, 1)
	go func() { code <- RunPipe([]string{"a", strconv.Itoa(ln.Addr().(*net.TCPAddr).Port)}, &out, &errOut) }()
	<-connected
	var ls daemon.LsReply
	if err := daemon.Call(b, daemon.Request{Op: "ls"}, &ls); err != nil {
		t.Fatal(err)
	}
	var subject string
	for _, m := range ls.Members {
		if m.Name == "a" {
			subject = m.SignPub
		}
	}
	var res struct{ Results []daemon.PushResult }
	if err := daemon.Call(b, daemon.Request{Op: "revoke", Subject: subject}, &res); err != nil {
		t.Fatal(err)
	}
	if got := <-code; got != 255 || !strings.Contains(errOut.String(), "revoked") || strings.Count(errOut.String(), "\n") != 1 {
		t.Fatalf("pipe exit %d, stderr %q; want 255 and one line naming the revoke", got, errOut.String())
	}
}
