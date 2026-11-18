package daemon

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/session"
	"github.com/goat-si/goat/apps/pen/internal/state"
	"github.com/goat-si/goat/apps/pen/internal/stream"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// phone is a key that is not a member: what a phone paired with GOAT holds.
func phone(t *testing.T) *ident.Identity {
	t.Helper()
	s, n := make([]byte, 32), make([]byte, 32)
	rand.Read(s)
	rand.Read(n)
	id, err := ident.FromSeeds(s, n)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func noiseText(id *ident.Identity) string { return ident.B64.EncodeToString(id.NoisePub) }

// op sends one op line on an open registration and returns its answer.
func (h *holder) op(t *testing.T, line string) map[string]any {
	t.Helper()
	if _, err := h.c.Write([]byte(line + "\n")); err != nil {
		t.Fatal(err)
	}
	m, ok := h.next(t)
	if !ok {
		t.Fatalf("no answer to %s", line)
	}
	return m
}

// setList sends a list and requires it applied.
func (h *holder) setList(t *testing.T, gen int, keys ...*ident.Identity) {
	t.Helper()
	var es []string
	for i, k := range keys {
		es = append(es, entry(clientID(i), noiseText(k)))
	}
	if m := h.op(t, listOp(gen, es...)); m["t"] != "clients" {
		t.Fatalf("list %d answered %v", gen, m)
	}
}

func dialAs(ctx context.Context, rs *relaytest.Server, id *ident.Identity, n *node, p session.Payload) (*session.Secure, error) {
	return openMember(ctx, []string{rs.URL}, id, n.d.NodeID(), n.id.NoisePub, p)
}

func goatService() session.Payload { return session.Payload{V: 1, Stream: "service", Name: "goat"} }

// echo sends one DATA record on an open service stream and reads the echoed one.
func echo(ctx context.Context, sec *session.Secure, msg string) error {
	if err := sec.Send(append([]byte{stream.TypeData}, msg...)); err != nil {
		return err
	}
	for {
		rec, err := sec.Recv(ctx)
		if err != nil {
			return err
		}
		if len(rec) > 0 && rec[0] == stream.TypeData {
			if string(rec[1:]) != msg {
				return &relay.CloseError{Code: 1}
			}
			return nil
		}
	}
}

// closedWith sends FIN, then reads until the session closes and returns the code. The FIN lets a session that nobody
// closes end on its own (1000), so a missing close fails instead of hanging.
func closedWith(ctx context.Context, sec *session.Secure) uint16 {
	sec.Send([]byte{stream.TypeFin})
	for {
		if _, err := sec.Recv(ctx); err != nil {
			return relay.CodeOf(err)
		}
	}
}

type clientFixture struct {
	ctx   context.Context
	rs    *relaytest.Server
	a     *node
	prog  *program
	h     *holder
	ended chan string
}

func newClientFixture(t *testing.T) *clientFixture {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	rs := relaytest.New()
	t.Cleanup(rs.Close)
	// Buffer teardown notifications so registrations can end without a waiting test.
	ended := make(chan string, 16)
	a := hookedFounder(t, ctx, rs, func(o *Options) { o.ServiceEnded = func(id string) { ended <- id } })
	key := newKey(t)
	prog := newProgram(t, "goat", key)
	prog.serve()
	h := register(t, a, "goat", prog.port(), key)
	return &clientFixture{ctx: ctx, rs: rs, a: a, prog: prog, h: h, ended: ended}
}

func awaitEnded(t *testing.T, ctx context.Context, ended <-chan string, id any) {
	t.Helper()
	waitCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	select {
	case got := <-ended:
		if got != id {
			t.Fatalf("registration %s ended, want %v", got, id)
		}
	case <-waitCtx.Done():
		t.Fatalf("registration %v did not end: %v", id, waitCtx.Err())
	}
}

func TestAListedClientKeyOpensTheGoatServiceAndTheProgramReadsItsClientLine(t *testing.T) {
	f := newClientFixture(t)
	p := phone(t)
	f.h.setList(t, 1, p)
	sec, err := dialAs(f.ctx, f.rs, p, f.a, goatService())
	if err != nil {
		t.Fatalf("a listed key's service stream: %v", err)
	}
	if err := echo(f.ctx, sec, "hello"); err != nil {
		t.Fatalf("echo: %v", err)
	}
	want := `{"v":1,"mesh":"` + f.a.ls(t).MeshID + `","self":"` + f.a.d.NodeID() + `","client":{"id":"` + clientID(0) +
		`","noisePub":"` + noiseText(p) + `"},"stream":"goat"}`
	if j := <-f.prog.identities; string(j) != want {
		t.Fatalf("identity line\n got %s\nwant %s", j, want)
	}
}

func TestAListedClientKeyIsRefusedForEveryOtherStreamAndAnUnlistedKeyForAll(t *testing.T) {
	f := newClientFixture(t)
	p, stranger := phone(t), phone(t)
	other := newProgram(t, "other", newKey(t))
	other.serve()
	register(t, f.a, "other", other.port(), other.key)
	f.h.setList(t, 1, p)
	refused := func(why string, id *ident.Identity, kind byte, payload any) {
		t.Helper()
		conn, err := relay.Dial(f.ctx, f.rs.URL, f.a.d.NodeID())
		if err != nil {
			t.Fatal(err)
		}
		_, err = session.Initiate(f.ctx, conn, kind, f.a.d.NodeID(), f.a.id.NoisePub, id, make([]byte, 32), payload)
		if relay.CodeOf(err) != wire.CodeNotAdmitted {
			t.Errorf("%s: got %v, want 4401 before message 2", why, err)
		}
	}
	refused("tcp", p, session.KindSession, session.Payload{V: 1, Stream: "tcp", Port: 22})
	refused("mesh", p, session.KindSession, session.Payload{V: 1, Stream: "mesh"})
	refused("another service", p, session.KindSession, session.Payload{V: 1, Stream: "service", Name: "other"})
	refused("an unregistered service", p, session.KindSession, session.Payload{V: 1, Stream: "service", Name: "nobody"})
	refused("an account session", p, session.KindAccount, session.Payload{V: 1, Stream: "account", Name: "phone"})
	refused("a join without an invite", p, session.KindJoin, session.Payload{V: 1, Stream: "join", Invite: "AAAAAAAAAAAAAAAA", Name: "phone"})
	refused("an unlisted key on goat", stranger, session.KindSession, goatService())
}

func TestAMeshChangeLeavesAClientSessionOpen(t *testing.T) {
	f := newClientFixture(t)
	p := phone(t)
	f.h.setList(t, 1, p)
	sec, err := dialAs(f.ctx, f.rs, p, f.a, goatService())
	if err != nil {
		t.Fatal(err)
	}
	if err := echo(f.ctx, sec, "before"); err != nil {
		t.Fatal(err)
	}
	joiner(t, f.ctx, f.rs, f.a.invite(t, time.Minute), "b") // a's view changes before the join returns
	if err := echo(f.ctx, sec, "after"); err != nil {
		t.Fatalf("after a mesh change the client session got %v; want it open", err)
	}
}

// keyOf makes a state directory with an identity that is not yet a member.
func keyOf(t *testing.T, rs *relaytest.Server, name string) (*state.Store, *ident.Identity) {
	t.Helper()
	st := shortDir(t)
	return st, identity(t, st, rs.URL, name)
}

func TestAListedKeyThatJoinsTheMeshLosesItsClientSessionAndIsAMemberFromThen(t *testing.T) {
	f := newClientFixture(t)
	st, k := keyOf(t, f.rs, "k")
	f.h.setList(t, 1, k)
	sec, err := dialAs(f.ctx, f.rs, k, f.a, goatService())
	if err != nil {
		t.Fatal(err)
	}
	if err := echo(f.ctx, sec, "x"); err != nil {
		t.Fatal(err)
	}
	<-f.prog.identities
	s, err := Join(f.ctx, st, k, f.a.invite(t, time.Minute), "k")
	if err != nil {
		t.Fatal(err)
	}
	_ = s
	if code := closedWith(f.ctx, sec); code != wire.CodeNotAdmitted {
		t.Fatalf("the client session of a key that became a member closed %d, want 4401", code)
	}
	// From now on the key is a member: a member stream works, and its service stream is a member's.
	msec, err := dialAs(f.ctx, f.rs, k, f.a, goatService())
	if err != nil {
		t.Fatal(err)
	}
	if err := echo(f.ctx, msec, "m"); err != nil {
		t.Fatal(err)
	}
	var j struct{ Caller *struct{ Name string } }
	if err := json.Unmarshal(<-f.prog.identities, &j); err != nil || j.Caller == nil || j.Caller.Name != "k" {
		t.Fatalf("the key's service stream after joining carried %+v, want the member line", j)
	}
	if m := f.h.op(t, listOp(2, entry(clientID(0), noiseText(k)))); m["t"] != "refused" {
		t.Fatalf("a list naming a member answered %v", m)
	}
}

func TestARevokedMembersKeyIsNeverAdmittedAsAClient(t *testing.T) {
	f := newClientFixture(t)
	st, k := keyOf(t, f.rs, "k")
	f.h.setList(t, 1, k)
	if _, err := Join(f.ctx, st, k, f.a.invite(t, time.Minute), "k"); err != nil {
		t.Fatal(err)
	}
	var out struct{ Results []PushResult }
	if err := Call(f.a.st, Request{Op: "revoke", Subject: ident.B64.EncodeToString(k.SignPub)}, &out); err != nil {
		t.Fatal(err)
	}
	if _, err := dialAs(f.ctx, f.rs, k, f.a, goatService()); relay.CodeOf(err) != wire.CodeNotAdmitted {
		t.Fatalf("a revoked member's key, still on the list, got %v; want 4401", err)
	}
}

func TestAListThatDropsAKeyClosesItsSessionsAndDeliveriesBeforeItsAnswer(t *testing.T) {
	f := newClientFixture(t)
	p, q := phone(t), phone(t)
	f.h.setList(t, 1, p, q)
	sec, err := dialAs(f.ctx, f.rs, p, f.a, goatService())
	if err != nil {
		t.Fatal(err)
	}
	if err := echo(f.ctx, sec, "x"); err != nil {
		t.Fatal(err)
	}
	<-f.prog.identities
	f.h.setList(t, 2, q)
	f.a.d.mu.Lock()
	for _, l := range f.a.d.sessions {
		if l.remote == noiseText(p) {
			f.a.d.mu.Unlock()
			t.Fatal("a session of the dropped key is still live after the list answer")
		}
	}
	f.a.d.mu.Unlock()
	if code := closedWith(f.ctx, sec); code != wire.CodeNotAdmitted {
		t.Fatalf("the dropped key's session closed %d, want 4401", code)
	}
	if _, err := dialAs(f.ctx, f.rs, p, f.a, goatService()); relay.CodeOf(err) != wire.CodeNotAdmitted {
		t.Fatalf("the dropped key reconnected: %v", err)
	}
}

func TestAKeyDroppedBetweenItsConfirmationAndTheCommitIsNeverDelivered(t *testing.T) {
	f := newClientFixture(t)
	f.prog.reached, f.prog.hold = make(chan struct{}, 1), make(chan struct{})
	p := phone(t)
	f.h.setList(t, 1, p)
	sec, err := dialAs(f.ctx, f.rs, p, f.a, goatService())
	if err != nil {
		t.Fatal(err)
	}
	<-f.prog.reached // the node dialled the program and is waiting for line 2, before its commit
	f.h.setList(t, 2)
	close(f.prog.hold)
	select {
	case j := <-f.prog.identities:
		t.Fatalf("the program got an identity for a dropped key: %s", j)
	case raw := <-f.prog.raw:
		if bytes.Contains(raw, []byte("client")) {
			t.Fatalf("the program read %q", raw)
		}
	}
	if code := closedWith(f.ctx, sec); code != wire.CodeNotAdmitted {
		t.Fatalf("closed %d, want 4401", code)
	}
}

func TestAKeyDroppedAndListedAgainBeforeTheCommitIsNotDeliveredOnTheDroppedSession(t *testing.T) {
	f := newClientFixture(t)
	f.prog.reached, f.prog.hold = make(chan struct{}, 1), make(chan struct{})
	p := phone(t)
	f.h.setList(t, 1, p)
	sec, err := dialAs(f.ctx, f.rs, p, f.a, goatService())
	if err != nil {
		t.Fatal(err)
	}
	<-f.prog.reached     // the node dialled the program and is waiting for line 2, before its commit
	f.h.setList(t, 2)    // the drop claims the session's close
	f.h.setList(t, 3, p) // the key is listed again, with an id, when the commit runs
	close(f.prog.hold)
	select {
	case j := <-f.prog.identities:
		t.Fatalf("the dropped session reached the program with %s", j)
	case raw := <-f.prog.raw:
		if bytes.Contains(raw, []byte("client")) {
			t.Fatalf("the program read %q", raw)
		}
	}
	if code := closedWith(f.ctx, sec); code != wire.CodeNotAdmitted {
		t.Fatalf("closed %d, want 4401", code)
	}
}

func TestTheEndOfARegistrationClosesItsClientSessions4401AndForgetsItsList(t *testing.T) {
	f := newClientFixture(t)
	p := phone(t)
	f.h.setList(t, 1, p)
	sec, err := dialAs(f.ctx, f.rs, p, f.a, goatService())
	if err != nil {
		t.Fatal(err)
	}
	if err := echo(f.ctx, sec, "x"); err != nil {
		t.Fatal(err)
	}
	f.h.c.Close()
	// closedWith's FIN would end the session normally (1000) if it reached the program before the end did.
	awaitEnded(t, f.ctx, f.ended, f.h.reply["id"])
	if code := closedWith(f.ctx, sec); code != wire.CodeNotAdmitted {
		t.Fatalf("a client session of an ended registration closed %d, want 4401", code)
	}
	register(t, f.a, "goat", f.prog.port(), f.prog.key)
	if _, err := dialAs(f.ctx, f.rs, p, f.a, goatService()); relay.CodeOf(err) != wire.CodeNotAdmitted {
		t.Fatalf("the old list admitted %v under a new registration", err)
	}
}

func TestAClientSessionMarksNothingOnlineAndAppearsInNoMemberList(t *testing.T) {
	f := newClientFixture(t)
	p := phone(t)
	f.h.setList(t, 1, p)
	sec, err := dialAs(f.ctx, f.rs, p, f.a, goatService())
	if err != nil {
		t.Fatal(err)
	}
	if err := echo(f.ctx, sec, "x"); err != nil {
		t.Fatal(err)
	}
	f.a.d.mu.Lock()
	_, seen := f.a.d.seen[ident.B64.EncodeToString(p.SignPub)]
	_, versioned := f.a.d.versions[noiseText(p)]
	snapshot := string(f.a.d.snapshotLineLocked())
	f.a.d.mu.Unlock()
	if seen || versioned || bytes.Contains([]byte(snapshot), []byte(noiseText(p))) {
		t.Fatalf("a client left a member trace: seen %v, version %v, snapshot %s", seen, versioned, snapshot)
	}
	for _, m := range f.a.ls(t).Members {
		if m.NoisePub == noiseText(p) {
			t.Fatal("ls lists a client")
		}
	}
}

func TestAListedKeyThatJoinsWhileItsDeliveryWaitsBeforeTheCommitIsNeverDelivered(t *testing.T) {
	f := newClientFixture(t)
	f.prog.reached, f.prog.hold = make(chan struct{}, 1), make(chan struct{})
	st, k := keyOf(t, f.rs, "k")
	f.h.setList(t, 1, k)
	sec, err := dialAs(f.ctx, f.rs, k, f.a, goatService())
	if err != nil {
		t.Fatal(err)
	}
	<-f.prog.reached // waiting for line 2, before the commit
	if _, err := Join(f.ctx, st, k, f.a.invite(t, time.Minute), "k"); err != nil {
		t.Fatal(err)
	}
	if code := closedWith(f.ctx, sec); code != wire.CodeNotAdmitted {
		t.Fatalf("closed %d, want 4401 when the key became a member", code)
	}
	close(f.prog.hold)
	select {
	case j := <-f.prog.identities:
		t.Fatalf("the program got an identity line after the key became a member: %s", j)
	case <-f.prog.raw:
	}
}
