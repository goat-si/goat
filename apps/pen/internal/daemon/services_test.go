package daemon

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/session"
	"github.com/goat-si/goat/apps/pen/internal/state"
	"github.com/goat-si/goat/apps/pen/internal/stream"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

func newKey(t *testing.T) []byte {
	t.Helper()
	k := make([]byte, 32)
	rand.Read(k)
	return k
}

func testMAC(key []byte, label string, parts ...[]byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(label))
	for _, p := range parts {
		h.Write(p)
	}
	return h.Sum(nil)
}

// holder is a control connection that registered (or tried to register) a service.
type holder struct {
	c     net.Conn
	r     *bufio.Reader
	reply map[string]any
}

// next reads the holder's next control line; ok is false at EOF.
func (h *holder) next(t *testing.T) (map[string]any, bool) {
	t.Helper()
	line, err := h.r.ReadBytes('\n')
	if err != nil {
		return nil, false
	}
	var m map[string]any
	if err := json.Unmarshal(line, &m); err != nil {
		t.Fatalf("control line %q: %v", line, err)
	}
	return m, true
}

// rawControl sends one raw request line and reads the first answer, keeping the connection open.
func rawControl(t *testing.T, n *node, line string) *holder {
	t.Helper()
	c, err := net.Dial("unix", SocketPath(n.st))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	if _, err := c.Write([]byte(line + "\n")); err != nil {
		t.Fatal(err)
	}
	h := &holder{c: c, r: bufio.NewReader(c)}
	m, ok := h.next(t)
	if !ok {
		t.Fatalf("no answer to %s", line)
	}
	h.reply = m
	return h
}

func register(t *testing.T, n *node, name string, port int, key []byte) *holder {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"op": "service.register", "name": name, "port": port, "key": ident.B64.EncodeToString(key)})
	h := rawControl(t, n, string(b))
	if h.reply["t"] != "registered" || h.reply["name"] != name {
		t.Fatalf("register %s answered %v", name, h.reply)
	}
	return h
}

// program is a fake registered service: it runs the program side of the local delivery.
type program struct {
	ln   net.Listener
	key  []byte
	name string
	// hold, when set, is received from after line 1 and before line 2 (each connection signals reached first).
	reached chan struct{}
	hold    chan struct{}
	// identities receives J of every verified connection; raw receives everything a connection read when it
	// ended without a verified line 3.
	identities chan []byte
	raw        chan []byte
	// ended, when set, receives how the payload copy of a verified connection ended: nil at the caller's FIN.
	ended chan error
	// accepts counts every connection the node made to the program.
	accepts atomic.Int64
	// finished, when set, receives a value as each connection's handler returns (the node closed it or it failed).
	finished chan struct{}
}

func newProgram(t *testing.T, name string, key []byte) *program {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	p := &program{ln: ln, key: key, name: name, identities: make(chan []byte, 64), raw: make(chan []byte, 64)}
	return p
}

func (p *program) port() int { return p.ln.Addr().(*net.TCPAddr).Port }

func (p *program) serve() {
	go func() {
		for {
			c, err := p.ln.Accept()
			if err != nil {
				return
			}
			p.accepts.Add(1)
			go p.handle(c)
		}
	}()
}

func (p *program) handle(c net.Conn) {
	if p.finished != nil {
		defer func() { p.finished <- struct{}{} }()
	}
	defer c.Close()
	var seen bytes.Buffer
	r := bufio.NewReader(io.TeeReader(c, &seen))
	line1, err := r.ReadString('\n')
	if err != nil || !strings.HasPrefix(line1, "PENSVC/1 ") || len(line1) != 53 {
		io.Copy(io.Discard, r)
		p.raw <- seen.Bytes()
		return
	}
	nd, err := ident.B64.DecodeString(line1[9:52])
	if err != nil {
		p.raw <- seen.Bytes()
		return
	}
	if p.reached != nil {
		p.reached <- struct{}{}
	}
	if p.hold != nil {
		<-p.hold
	}
	ng := make([]byte, 32)
	rand.Read(ng)
	a := testMAC(p.key, "pen-svc/1 "+p.name, nd, ng)
	if _, err := c.Write([]byte(ident.B64.EncodeToString(ng) + " " + ident.B64.EncodeToString(a) + "\n")); err != nil {
		p.raw <- seen.Bytes()
		return
	}
	line3, err := r.ReadBytes('\n')
	if err != nil {
		p.raw <- seen.Bytes()
		return
	}
	sp := bytes.LastIndexByte(line3, ' ')
	if sp < 0 {
		p.raw <- seen.Bytes()
		return
	}
	j := line3[:sp]
	b, err := ident.B64.DecodeString(string(line3[sp+1 : len(line3)-1]))
	if err != nil || !hmac.Equal(b, testMAC(p.key, "pen-svc/1 pen", nd, ng, j)) {
		p.raw <- seen.Bytes()
		return
	}
	p.identities <- append([]byte(nil), j...)
	_, err = io.Copy(c, r) // echo the payload
	if p.ended != nil {
		p.ended <- err
	}
	c.(*net.TCPConn).CloseWrite()
}

func openService(t *testing.T, ctx context.Context, relays []string, from *node, to mesh.Member, name string) (*session.Secure, error) {
	t.Helper()
	noise, _ := ident.DecodeKey(to.NoisePub)
	return openMember(ctx, relays, from.id, to.NodeID, noise, session.Payload{V: 1, Stream: "service", Name: name})
}

// echoOnce sends msg with FIN on sec and returns what came back.
func echoOnce(ctx context.Context, sec *session.Secure, msg string) (string, error) {
	var got bytes.Buffer
	err := stream.Splice(ctx, sec, strings.NewReader(msg), &got, nil)
	return got.String(), err
}

func TestServiceStreamIsDeliveredOnlyToTheProgramThatPassesTheProof(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	key := newKey(t)
	good := newProgram(t, "goat", key)
	good.serve()
	register(t, a, "goat", good.port(), key)

	sec, err := openService(t, ctx, []string{rs.URL}, b, memberNamed(t, b, "a"), "goat")
	if err != nil {
		t.Fatal(err)
	}
	if got, err := echoOnce(ctx, sec, "hello"); err != nil || got != "hello" {
		t.Fatalf("echo %q, %v", got, err)
	}
	j := <-good.identities
	bm, am := memberNamed(t, a, "b"), memberNamed(t, a, "a")
	want := `{"v":1,"mesh":"` + a.ls(t).MeshID + `","self":"` + am.NodeID + `","caller":{"nodeId":"` + bm.NodeID +
		`","signPub":"` + bm.SignPub + `","noisePub":"` + bm.NoisePub + `","name":"b"},"stream":"goat"}`
	if string(j) != want {
		t.Fatalf("identity line\n got %s\nwant %s", j, want)
	}

	// A program whose answer does not prove K gets nothing past line 1, and the caller gets 4404.
	bad := newProgram(t, "goat", newKey(t))
	bad.serve()
	register(t, a, "goat", bad.port(), key)
	sec, err = openService(t, ctx, []string{rs.URL}, b, memberNamed(t, b, "a"), "goat")
	if err != nil {
		t.Fatal(err)
	}
	sec.Send(append([]byte{stream.TypeData}, "secret"...))
	if _, err := sec.Recv(ctx); relay.CodeOf(err) != wire.CodeOffline {
		t.Fatalf("got %v, want 4404 for a failed proof", err)
	}
	if got := <-bad.raw; bytes.Contains(got, []byte("secret")) || bytes.Count(got, []byte("\n")) != 1 {
		t.Fatalf("a program that failed the proof read %q", got)
	}
}

func TestASquatterOnTheRegisteredPortReceivesOnlyTheNodesNonce(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	got := make(chan []byte, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		r := bufio.NewReader(c)
		line, _ := r.ReadBytes('\n')
		c.Write([]byte("not an answer\n"))
		rest, _ := io.ReadAll(r)
		got <- append(line, rest...)
	}()
	register(t, a, "goat", ln.Addr().(*net.TCPAddr).Port, newKey(t))
	sec, err := openService(t, ctx, []string{rs.URL}, b, memberNamed(t, b, "a"), "goat")
	if err != nil {
		t.Fatal(err)
	}
	sec.Send(append([]byte{stream.TypeData}, "secret"...))
	if _, err := sec.Recv(ctx); relay.CodeOf(err) != wire.CodeOffline {
		t.Fatalf("got %v, want 4404", err)
	}
	line := <-got
	if len(line) != 53 || !strings.HasPrefix(string(line), "PENSVC/1 ") || line[52] != '\n' {
		t.Fatalf("squatter read %q, want only line 1", line)
	}
	if _, err := ident.DecodeKey(string(line[9:52])); err != nil {
		t.Fatalf("line 1 nonce %q: %v", line[9:52], err)
	}
}

func TestARegistrationEndsOnlyWithItsOwnConnectionAndAReplacementClosesTheOldHolder(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	ended := make(chan string, 4)
	st := shortDir(t)
	id := identity(t, st, rs.URL, "a")
	if _, err := mesh.Found(st, id, "a", 1); err != nil {
		t.Fatal(err)
	}
	a := startWith(t, ctx, rs, st, func(o *Options) { o.ServiceEnded = func(id string) { ended <- id } })
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	k1, k2 := newKey(t), newKey(t)
	p1, p2 := newProgram(t, "goat", k1), newProgram(t, "goat", k2)
	p1.serve()
	p2.serve()
	old := register(t, a, "goat", p1.port(), k1)
	now := register(t, a, "goat", p2.port(), k2)
	m, ok := old.next(t)
	if !ok || m["t"] != "replaced" || m["id"] != old.reply["id"] {
		t.Fatalf("old holder got %v, %v; want replaced naming its id", m, ok)
	}
	if _, err := old.r.ReadBytes('\n'); !errors.Is(err, io.EOF) {
		t.Fatalf("old holder's connection after the replacement: %v, want a clean EOF", err)
	}
	if got := <-ended; got != old.reply["id"] {
		t.Fatalf("ended %q, want the old registration %v", got, old.reply["id"])
	}
	sec, err := openService(t, ctx, []string{rs.URL}, b, memberNamed(t, b, "a"), "goat")
	if err != nil {
		t.Fatal(err)
	}
	if got, err := echoOnce(ctx, sec, "x"); err != nil || got != "x" {
		t.Fatalf("after the old holder ended: %q, %v (the new registration must stay)", got, err)
	}
	<-p2.identities
	now.c.Close()
	if got := <-ended; got != now.reply["id"] {
		t.Fatalf("ended %q, want %v", got, now.reply["id"])
	}
	sec, err = openService(t, ctx, []string{rs.URL}, b, memberNamed(t, b, "a"), "goat")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sec.Recv(ctx); relay.CodeOf(err) != wire.CodeOffline {
		t.Fatalf("got %v, want 4404 once no program holds the name", err)
	}
}

func TestAReplacementBeforeTheCommitFailsTheDeliveryAndTheOldProgramGetsNoIdentity(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	k1 := newKey(t)
	p1 := newProgram(t, "goat", k1)
	p1.reached, p1.hold = make(chan struct{}, 1), make(chan struct{})
	p1.serve()
	old := register(t, a, "goat", p1.port(), k1)
	sec, err := openService(t, ctx, []string{rs.URL}, b, memberNamed(t, b, "a"), "goat")
	if err != nil {
		t.Fatal(err)
	}
	<-p1.reached
	k2 := newKey(t)
	p2 := newProgram(t, "goat", k2)
	p2.serve()
	register(t, a, "goat", p2.port(), k2)
	if m, ok := old.next(t); !ok || m["t"] != "replaced" {
		t.Fatalf("old holder got %v", m)
	}
	close(p1.hold) // p1 now answers with a valid proof for the registration that was replaced
	if _, err := sec.Recv(ctx); relay.CodeOf(err) != wire.CodeOffline {
		t.Fatalf("got %v, want 4404", err)
	}
	if got := <-p1.raw; bytes.Count(got, []byte("\n")) != 1 {
		t.Fatalf("the replaced program read %q, want only line 1", got)
	}
}

func TestAHolderThatExitsClosesTheConnectionsDeliveredToIt(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	key := newKey(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	p := &program{ln: ln, key: key, name: "goat", identities: make(chan []byte, 1), raw: make(chan []byte, 1)}
	p.serve()
	h := register(t, a, "goat", p.port(), key)
	sec, err := openService(t, ctx, []string{rs.URL}, b, memberNamed(t, b, "a"), "goat")
	if err != nil {
		t.Fatal(err)
	}
	if err := sec.Send(append([]byte{stream.TypeData}, "ping"...)); err != nil {
		t.Fatal(err)
	}
	<-p.identities
	h.c.Close()
	for {
		if _, err := sec.Recv(ctx); err != nil {
			if relay.CodeOf(err) == 0 {
				t.Fatalf("got %v, want a close from the node", err)
			}
			break
		}
	}
}

func TestAServiceStreamTheRelayCutsResetsTheProgramInsteadOfEndingItCleanly(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	key := newKey(t)
	p := newProgram(t, "goat", key)
	p.ended = make(chan error, 1)
	p.serve()
	register(t, a, "goat", p.port(), key)
	sec, err := openService(t, ctx, []string{rs.URL}, b, memberNamed(t, b, "a"), "goat")
	if err != nil {
		t.Fatal(err)
	}
	if err := sec.Send(append([]byte{stream.TypeData}, "partial"...)); err != nil {
		t.Fatal(err)
	}
	if _, err := sec.Recv(ctx); err != nil { // the program's echo: it holds the stream
		t.Fatal(err)
	}
	if !rs.DropUplink(a.id.NodeID()) {
		t.Fatal("a has no uplink to drop")
	}
	if err := <-p.ended; err == nil {
		t.Fatal("the program read the end of the stream after the relay cut it; want a reset")
	}
}

func TestUnknownServiceNameClosesAfterConfirmationWith4404(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	sec, err := openService(t, ctx, []string{rs.URL}, b, memberNamed(t, b, "a"), "goat")
	if err != nil {
		t.Fatalf("the handshake itself must complete (refusal comes after confirmation): %v", err)
	}
	if _, err := sec.Recv(ctx); relay.CodeOf(err) != wire.CodeOffline {
		t.Fatalf("got %v, want CLOSE 4404", err)
	}
}

func TestAMemberIsDeliveredAndANonMemberGets4401WithoutADial(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	key := newKey(t)
	p := newProgram(t, "goat", key)
	p.serve()
	register(t, a, "goat", p.port(), key)
	sec, err := openService(t, ctx, []string{rs.URL}, b, memberNamed(t, b, "a"), "goat")
	if err != nil {
		t.Fatal(err)
	}
	if got, err := echoOnce(ctx, sec, "m"); err != nil || got != "m" {
		t.Fatalf("member: %q, %v", got, err)
	}
	<-p.identities
	dialed := p.accepts.Load()
	stranger, _ := ident.Generate(nil)
	noise, _ := ident.DecodeKey(memberNamed(t, a, "a").NoisePub)
	_, err = openMember(ctx, []string{rs.URL}, stranger, a.d.NodeID(), noise, session.Payload{V: 1, Stream: "service", Name: "goat"})
	if relay.CodeOf(err) != wire.CodeNotAdmitted {
		t.Fatalf("non-member got %v, want 4401 before message 2", err)
	}
	if n := p.accepts.Load(); n != dialed {
		t.Fatalf("the node dialed the program %d more time(s) for a non-member", n-dialed)
	}
}

func TestRevokeClosesADeliveredServiceConnection(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	key := newKey(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	p := &program{ln: ln, key: key, name: "goat", identities: make(chan []byte, 1), raw: make(chan []byte, 1)}
	p.serve()
	register(t, a, "goat", p.port(), key)
	sec, err := openService(t, ctx, []string{rs.URL}, b, memberNamed(t, b, "a"), "goat")
	if err != nil {
		t.Fatal(err)
	}
	sec.Send(append([]byte{stream.TypeData}, "x"...))
	<-p.identities
	var res struct{ Results []PushResult }
	if err := Call(a.st, Request{Op: "revoke", Subject: memberNamed(t, a, "b").SignPub}, &res); err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := sec.Recv(ctx); err != nil {
			if relay.CodeOf(err) != wire.CodeNotAdmitted {
				t.Fatalf("got %v, want 4401", err)
			}
			break
		}
	}
}

func TestServiceRegisterWorksOnTheControlSocketAndIsUnknownToTheDashboardPath(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	key := ident.B64.EncodeToString(newKey(t))
	for _, op := range []string{"service.register", "watch.snapshot"} {
		_, err := a.d.do(ctx, Request{Op: op, Name: "goat"})
		if err == nil || !strings.Contains(err.Error(), "unknown op") {
			t.Fatalf("the dashboard path ran %s: %v", op, err)
		}
	}
	sec, err := openService(t, ctx, []string{rs.URL}, b, memberNamed(t, b, "a"), "goat")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sec.Recv(ctx); relay.CodeOf(err) != wire.CodeOffline {
		t.Fatalf("got %v, want 4404: nothing may be registered through the dashboard path", err)
	}
	h := rawControl(t, a, `{"op":"service.register","name":"goat","port":1,"key":"`+key+`"}`)
	if h.reply["t"] != "registered" {
		t.Fatalf("control socket answered %v", h.reply)
	}
}

func TestServiceRegisterRefusesBadInput(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	key := ident.B64.EncodeToString(newKey(t))
	for _, line := range []string{
		`{"op":"service.register","name":"pen","port":1,"key":"` + key + `"}`,
		`{"op":"service.register","name":"Goat","port":1,"key":"` + key + `"}`,
		`{"op":"service.register","name":"goat","port":0,"key":"` + key + `"}`,
		`{"op":"service.register","name":"goat","port":1,"key":"` + key[:42] + `"}`,
		`{"op":"service.register","name":"goat","port":1,"key":"` + key[:42] + "_" + `"}`,
	} {
		h := rawControl(t, a, line)
		if _, ok := h.reply["error"]; !ok {
			t.Fatalf("%s answered %v, want an error", line, h.reply)
		}
		if _, ok := h.next(t); ok {
			t.Fatalf("%s: connection stayed open after a refusal", line)
		}
	}
	for i := range 8 {
		register(t, a, "s"+string(rune('a'+i)), 1, newKey(t))
	}
	h := rawControl(t, a, `{"op":"service.register","name":"ninth","port":1,"key":"`+key+`"}`)
	if _, ok := h.reply["error"]; !ok {
		t.Fatalf("a ninth name answered %v", h.reply)
	}
}

func TestThe33rdConcurrentDeliveryGetsCLOSE4429AfterConfirmation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// The Go relay caps 32 active sessions per node: 32 deliveries go through one relay, the 33rd through another.
	r1, r2 := relaytest.New(), relaytest.New()
	defer r1.Close()
	defer r2.Close()
	defer setDeliveryTimeouts(time.Hour)()
	st := shortDir(t)
	id, _, err := st.EnsureIdentity()
	if err != nil {
		t.Fatal(err)
	}
	cfg := state.Config{Name: "a"}
	cfg.SetRelays([]string{r1.URL, r2.URL})
	if err := st.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	if _, err := mesh.Found(st, id, "a", 1); err != nil {
		t.Fatal(err)
	}
	a := start(t, ctx, r1, st, nil)
	if err := r2.WaitOnline(ctx, a.d.NodeID()); err != nil {
		t.Fatal(err)
	}
	b := joiner(t, ctx, r1, a.invite(t, time.Minute), "b")
	key := newKey(t)
	p := newProgram(t, "goat", key)
	p.reached, p.hold = make(chan struct{}, 40), make(chan struct{})
	p.serve()
	defer close(p.hold)
	register(t, a, "goat", p.port(), key)
	am := memberNamed(t, b, "a")
	for i := range 32 {
		if _, err := openService(t, ctx, []string{r1.URL}, b, am, "goat"); err != nil {
			t.Fatalf("delivery %d: %v", i+1, err)
		}
		<-p.reached
	}
	sec, err := openService(t, ctx, []string{r2.URL}, b, am, "goat")
	if err != nil {
		t.Fatalf("the 33rd handshake must complete; the cap applies after confirmation: %v", err)
	}
	if _, err := sec.Recv(ctx); relay.CodeOf(err) != wire.CodeCaps {
		t.Fatalf("got %v, want CLOSE 4429", err)
	}
}

// setDeliveryTimeouts sets both local delivery deadlines and returns the restore.
func setDeliveryTimeouts(d time.Duration) func() {
	dial, answer := deliveryDialTimeout, deliveryAnswerTimeout
	deliveryDialTimeout, deliveryAnswerTimeout = d, d
	return func() { deliveryDialTimeout, deliveryAnswerTimeout = dial, answer }
}

// snapLine is a watch.snapshot line.
type snapLine struct {
	T       string
	Gen     uint64
	Mesh    string
	Self    string
	Members []struct {
		NodeID, SignPub, NoisePub, Name, User string
		HostKeys                              []string
		Online                                bool
	}
	Revoked []NameRef
	Relays  []struct{ URL, Uplink string }
}

func snapWatch(t *testing.T, n *node) (*holder, func() snapLine) {
	t.Helper()
	h := rawControl(t, n, `{"op":"watch.snapshot"}`)
	pending := []map[string]any{h.reply}
	return h, func() snapLine {
		t.Helper()
		var m map[string]any
		if len(pending) > 0 {
			m, pending = pending[0], pending[1:]
		} else {
			var ok bool
			if m, ok = h.next(t); !ok {
				t.Fatal("snapshot watch ended")
			}
		}
		raw, _ := json.Marshal(m)
		for _, k := range []string{"gen", "mesh", "self", "members", "revoked"} {
			if _, ok := m[k]; !ok {
				t.Fatalf("snapshot line lacks %q: %s", k, raw)
			}
		}
		var s snapLine
		if err := json.Unmarshal(raw, &s); err != nil {
			t.Fatal(err)
		}
		return s
	}
}

func TestSnapshotWatchSendsCompleteLinesWhoseGenerationRisesByOnePerChange(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	// A relay state change publishes a line of its own: the daemon can record its uplink as up after founder
	// returns, or drop and reconnect it. Holding relaysMu keeps those changes out of the two attaches.
	next1, first, next2, second := func() (func() snapLine, snapLine, func() snapLine, snapLine) {
		a.d.relaysMu.Lock()
		defer a.d.relaysMu.Unlock()
		_, next1 := snapWatch(t, a)
		first := next1()
		_, next2 := snapWatch(t, a)
		return next1, first, next2, next2()
	}()
	if second.Gen != first.Gen {
		t.Fatalf("a new watcher raised the generation: %d then %d", first.Gen, second.Gen)
	}
	if first.T != "snapshot" || first.Mesh != a.ls(t).MeshID || first.Self != a.d.NodeID() || len(first.Members) != 1 {
		t.Fatalf("first line %+v", first)
	}
	self := first.Members[0]
	if self.SignPub != memberNamed(t, a, "a").SignPub || self.NoisePub != memberNamed(t, a, "a").NoisePub || self.HostKeys == nil || !self.Online {
		t.Fatalf("self entry %+v", self)
	}
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	bID := b.d.NodeID()
	for _, next := range []func() snapLine{next1, next2} {
		prev := first.Gen
		for {
			s := next()
			if s.Gen != prev+1 {
				t.Fatalf("generation went %d -> %d", prev, s.Gen)
			}
			prev = s.Gen
			found := false
			for _, m := range s.Members {
				found = found || m.NodeID == bID
			}
			if found {
				break
			}
		}
	}
	// The v1.1 watch keeps its line shape.
	w := rawControl(t, a, `{"op":"watch"}`)
	for k := range w.reply {
		if k != "t" && k != "at" && k != "members" && k != "revoked" {
			t.Fatalf("watch line gained %q: %v", k, w.reply)
		}
	}
	for range 6 {
		snapWatch(t, a)
	}
	if h := rawControl(t, a, `{"op":"watch.snapshot"}`); h.reply["error"] == nil {
		t.Fatalf("a ninth snapshot watcher was admitted: %v", h.reply)
	}
}

func TestTheIdentityLineCarriesTheCallerAsTheViewHoldsItAtTheCommit(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	key := newKey(t)
	p := newProgram(t, "goat", key)
	p.reached, p.hold = make(chan struct{}, 1), make(chan struct{})
	p.serve()
	register(t, a, "goat", p.port(), key)
	aw, stop := a.watch(t)
	defer stop()
	sec, err := openService(t, ctx, []string{rs.URL}, b, memberNamed(t, b, "a"), "goat")
	if err != nil {
		t.Fatal(err)
	}
	<-p.reached // the delivery dialed and sent line 1 while the caller was still named b
	var st Status
	if err := Call(b.st, Request{Op: "name", Name: "b2"}, &st); err != nil {
		t.Fatal(err)
	}
	untilView(t, aw, func(w WatchLine) bool {
		for _, m := range w.Members {
			if m.Name == "b2" {
				return true
			}
		}
		return false
	})
	close(p.hold)
	if j := <-p.identities; !bytes.Contains(j, []byte(`"name":"b2"`)) {
		t.Fatalf("identity line %s carries the caller as it was before the commit", j)
	}
	sec.Close(wire.CodeNormal)
}

func TestTheControlSocketClosesConnectionsPastItsCapAndServesTheOthers(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	was, wait := controlConnCap, controlRequestTimeout
	controlConnCap, controlRequestTimeout = 2, time.Hour // only the cap may close a connection here
	defer func() { controlConnCap, controlRequestTimeout = was, wait }()
	a := founder(t, ctx, rs, "a", nil)
	var held []net.Conn
	for range 2 {
		c, err := net.Dial("unix", SocketPath(a.st))
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		held = append(held, c)
	}
	extra, err := net.Dial("unix", SocketPath(a.st))
	if err != nil {
		t.Fatal(err)
	}
	defer extra.Close()
	if n, err := extra.Read(make([]byte, 1)); err == nil {
		t.Fatalf("the connection past the cap was served (%d bytes)", n)
	}
	for _, c := range held {
		c.Write([]byte(`{"op":"status"}` + "\n"))
		line, err := bufio.NewReader(c).ReadBytes('\n')
		if err != nil || !bytes.Contains(line, []byte(`"nodeId"`)) {
			t.Fatalf("a connection within the cap got %q, %v", line, err)
		}
	}
}

func TestAControlWriteToAClientThatStopsReadingEndsAtItsDeadline(t *testing.T) {
	was := controlWriteTimeout
	controlWriteTimeout = time.Millisecond
	defer func() { controlWriteTimeout = was }()
	server, client := net.Pipe() // a pipe has no buffer: a write waits for a reader that never comes
	defer client.Close()
	defer server.Close()
	var ne net.Error
	if _, err := (boundedConn{Conn: server}).Write([]byte("line\n")); !errors.As(err, &ne) || !ne.Timeout() {
		t.Fatalf("got %v, want a write timeout", err)
	}
}
