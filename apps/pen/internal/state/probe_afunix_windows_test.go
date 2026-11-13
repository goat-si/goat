package state

import (
	"bufio"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Diagnostic only (never merged): how often a pending read on a Windows AF_UNIX connection misses the peer's
// half-close (CloseWrite) or full close. Mirrors pen service register: one side writes a request, reads the answer,
// keeps a read pending, writes an op and then half-closes or closes; the other side has a read pending meanwhile.
// One Errorf prints the log.
func TestWindowsAFUnixCloseProbe(t *testing.T) {
	dir, err := os.MkdirTemp("", "afu")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	ln, err := net.Listen("unix", filepath.Join(dir, "p.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	const rounds, bound, maxMisses = 300, time.Second, 10
	type outcome struct{ misses, errs, ran int }
	run := func(name string, end func(child, node net.Conn)) outcome {
		var o outcome
		for i := 0; i < rounds && o.misses < maxMisses; i++ {
			o.ran++
			accepted := make(chan net.Conn, 1)
			go func() {
				c, err := ln.Accept()
				if err != nil {
					accepted <- nil
					return
				}
				accepted <- c
			}()
			child, err := net.Dial("unix", filepath.Join(dir, "p.sock"))
			if err != nil {
				o.errs++
				t.Logf("%s round %d: dial %v", name, i, err)
				<-accepted
				continue
			}
			node := <-accepted
			if node == nil {
				o.errs++
				child.Close()
				continue
			}
			nodeRead, childRead := make(chan error, 1), make(chan error, 1)
			go func() {
				r := bufio.NewReader(node)
				if _, err := r.ReadBytes('\n'); err != nil {
					nodeRead <- err
					return
				}
				node.Write([]byte("registered\n"))
				_, err := io.Copy(io.Discard, r)
				nodeRead <- err
			}()
			child.Write([]byte("register\n"))
			cr := bufio.NewReader(child)
			cr.ReadBytes('\n')
			go func() {
				_, err := io.Copy(io.Discard, cr)
				childRead <- err
			}()
			child.Write([]byte("op\n"))
			end(child, node)
			waitFor := nodeRead
			if name == "node closes, child's pending read" {
				waitFor = childRead
			}
			select {
			case err := <-waitFor:
				if err != nil {
					o.errs++
					if o.errs <= 3 {
						t.Logf("%s round %d: the read ended with %v (%#v)", name, i, err, err)
					}
				}
			case <-time.After(bound):
				o.misses++
				if o.misses <= 3 {
					t.Logf("%s round %d: the pending read did not wake within %v", name, i, bound)
				}
			}
			child.Close()
			node.Close()
		}
		return o
	}
	cases := []struct {
		name string
		end  func(child, node net.Conn)
	}{
		{"child half-closes, node's pending read", func(child, node net.Conn) {
			if err := child.(*net.UnixConn).CloseWrite(); err != nil {
				t.Logf("CloseWrite: %v", err)
			}
		}},
		{"child closes, node's pending read", func(child, node net.Conn) { child.Close() }},
		{"node closes, child's pending read", func(child, node net.Conn) { node.Close() }},
	}
	for _, c := range cases {
		o := run(c.name, c.end)
		t.Logf("%s: %d of %d rounds missed (bound %v, stops after %d misses), %d ended with an error", c.name, o.misses, o.ran, bound, maxMisses, o.errs)
	}
	t.Errorf("AF_UNIX close probe done: deliberate failure so go test prints the lines above")
}
