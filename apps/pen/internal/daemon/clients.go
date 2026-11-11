package daemon

import (
	"context"
	"errors"
	"net"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/session"
	"github.com/goat-si/goat/apps/pen/internal/stream"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// Client and pairing sessions (contract "Service clients") are closed by exactly one owner. Under d.mu the first party
// to find a session not closing claims it; only that owner closes the relay session and the local connection and then
// signals closed. Everyone else that needs the session gone waits on closed with no lock held. The commit and the
// identity line are written under the session's gate, which the owner takes before it closes, so no identity line is
// written after an owner finished. Lock order: l.gate, then d.mu, then serviceBook.mu; d.mu may read the view
// (meshMu, the store's mutex).

// clientAdmission is what message 1 of a session from a key that is not a member was admitted under: the registration
// whose list named the key.
type clientAdmission struct {
	reg *serviceReg
}

// memberOrRevoked reports a key that is, or was, a member of v: such a key is never a client.
func memberOrRevoked(v *mesh.View, key string) bool {
	if pub, err := ident.DecodeKey(key); err == nil {
		if _, member := v.MemberByNoise(pub); member {
			return true
		}
	}
	for _, m := range v.Revoked {
		if m.NoisePub == key {
			return true
		}
	}
	return false
}

// admitClient decides on a kind 0x01 service stream from a key that is not a member, before message 2.
func (d *Daemon) admitClient(remote []byte, p session.Payload) (clientAdmission, error) {
	key := ident.B64.EncodeToString(remote)
	if p.Stream != "service" || !ValidServiceName(p.Name) || memberOrRevoked(d.view(), key) {
		return clientAdmission{}, errNotAdmitted
	}
	d.svc.mu.Lock()
	defer d.svc.mu.Unlock()
	reg := d.svc.byName[p.Name]
	if reg == nil || reg.ended || reg.name != clientsService {
		return clientAdmission{}, errNotAdmitted
	}
	if _, listed := reg.clients[key]; !listed {
		return clientAdmission{}, errNotAdmitted
	}
	return clientAdmission{reg: reg}, nil
}

// listedAnywhere reports a key on any registration's list; such a key may not open an account session.
func (b *serviceBook) listedAnywhere(key string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, reg := range b.byName {
		if _, ok := reg.clients[key]; ok {
			return true
		}
	}
	return false
}

// registerClient records a confirmed client session if its registration is still current, still lists its key and
// the key is not a member or a revoked member.
func (d *Daemon) registerClient(l *live) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if memberOrRevoked(d.view(), l.remote) {
		return false
	}
	d.svc.mu.Lock()
	_, listed := l.reg.clients[l.remote]
	ok := listed && !l.reg.ended && d.svc.byName[l.reg.name] == l.reg
	d.svc.mu.Unlock()
	if !ok {
		return false
	}
	d.nextLive++
	l.k = d.nextLive
	d.sessions[l.k] = l
	return true
}

// claimLocked makes the caller the owner of l's close if nobody is; d.mu is held.
func claimLocked(l *live) bool {
	if l.closing {
		return false
	}
	l.closing = true
	return true
}

// closeOwned closes what an owner claimed: the local connection and the relay session, after any commit and identity
// line in progress; then it signals closed.
func (d *Daemon) closeOwned(l *live, code uint16) {
	l.gate.Lock()
	if l.conn != nil {
		l.conn.Close()
	}
	l.sec.Close(code)
	l.gate.Unlock()
	d.mu.Lock()
	delete(d.sessions, l.k)
	d.mu.Unlock()
	close(l.closed)
}

// closeLive closes l with code unless another owner already is (then that owner's code stands).
func (d *Daemon) closeLive(l *live, code uint16) {
	d.mu.Lock()
	won := claimLocked(l)
	d.mu.Unlock()
	if won {
		d.closeOwned(l, code)
	}
}

// closeAndWait closes the sessions mine claimed with 4401, then waits for every session in waits to be closed.
func (d *Daemon) closeAndWait(mine []*live, waits []chan struct{}) {
	for _, l := range mine {
		d.closeOwned(l, wire.CodeNotAdmitted)
	}
	for _, w := range waits {
		<-w
	}
}

// selectLocked claims the client sessions that match and collects every match's closed signal; d.mu is held.
func (d *Daemon) selectLocked(match func(*live) bool) (mine []*live, waits []chan struct{}) {
	for _, l := range d.sessions {
		if l.client && match(l) {
			if claimLocked(l) {
				mine = append(mine, l)
			}
			waits = append(waits, l.closed)
		}
	}
	return mine, waits
}

// endRegistration closes the client and pairing sessions admitted under reg with 4401 and the connections delivered
// to it, and returns once all of them are closed.
func (d *Daemon) endRegistration(reg *serviceReg, conns []net.Conn) {
	d.mu.Lock()
	mine, waits := d.selectLocked(func(l *live) bool { return l.reg == reg })
	d.mu.Unlock()
	for _, l := range mine {
		d.closeOwned(l, wire.CodeNotAdmitted)
	}
	closeAll(conns)
	for _, w := range waits {
		<-w
	}
}

// liveLink is a client session as a stream link: its closes go through the session's single owner.
type liveLink struct {
	d *Daemon
	l *live
}

func (k liveLink) Send(p []byte) error                      { return k.l.sec.Send(p) }
func (k liveLink) Recv(ctx context.Context) ([]byte, error) { return k.l.sec.Recv(ctx) }
func (k liveLink) Close(code uint16) error {
	k.d.closeLive(k.l, code)
	return nil
}

// serveClient delivers a confirmed client session to the program of the registration that admitted it.
func (d *Daemon) serveClient(ctx context.Context, sec *session.Secure, a clientAdmission) {
	l := &live{remote: ident.B64.EncodeToString(sec.RemoteStatic), sec: sec, client: true, reg: a.reg, closed: make(chan struct{})}
	if !d.registerClient(l) {
		sec.Close(wire.CodeNotAdmitted)
		return
	}
	defer d.closeLive(l, wire.CodeNormal)
	if !d.svc.acquire() {
		d.closeLive(l, wire.CodeCaps)
		return
	}
	held := true
	releaseSlot := func() {
		if held {
			held = false
			d.svc.release()
		}
	}
	defer releaseSlot()
	conn, err := d.deliverTo(ctx, l.reg, sec.RemoteStatic, l)
	if err != nil {
		d.logDelivery(l.reg, err)
		d.closeLive(l, wire.CodeOffline)
		return
	}
	defer conn.Close()
	defer d.svc.uncommit(l.reg, conn)
	releaseSlot()
	stream.Splice(ctx, liveLink{d, l}, conn, conn, conn.CloseWrite)
}

// commitClient commits a client delivery to l's registration and renders its identity line. It runs with l.gate held
// (the caller writes line 3 before releasing it) and fails once l is closing, the registration ended or was
// replaced, or the key is no longer listed or is now a member or a revoked member.
func (d *Daemon) commitClient(reg *serviceReg, tc net.Conn, l *live) ([]byte, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if l.closing {
		return nil, failed(causeReplaced, errors.New("the client session is closing"))
	}
	v := d.view()
	if memberOrRevoked(v, l.remote) {
		return nil, failed(causeReplaced, errors.New("the client key is now a member's"))
	}
	d.svc.mu.Lock()
	id, listed := reg.clients[l.remote]
	current := !reg.ended && d.svc.byName[reg.name] == reg
	if listed && current {
		if reg.conns == nil {
			reg.conns = map[net.Conn]struct{}{}
		}
		reg.conns[tc] = struct{}{}
	}
	d.svc.mu.Unlock()
	if !listed || !current {
		return nil, failed(causeReplaced, errors.New("the client is no longer listed by a current registration"))
	}
	j, err := clientIdentityLine(v.MeshID, d.nodeID, id, l.remote, reg.name)
	if err != nil {
		d.svc.uncommit(reg, tc)
		return nil, failed(causeMalformed, err)
	}
	l.conn = tc
	return j, nil
}

// dropClientsLocked claims the client sessions of reg whose keys list no longer names; d.mu is held.
func (d *Daemon) dropClientsLocked(reg *serviceReg, list map[string]string) ([]*live, []chan struct{}) {
	return d.selectLocked(func(l *live) bool {
		_, kept := list[l.remote]
		return l.reg == reg && !kept
	})
}
