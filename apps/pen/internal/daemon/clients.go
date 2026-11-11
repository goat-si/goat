package daemon

import (
	"context"
	"errors"
	"net"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relay"
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
	reg  *serviceReg
	slot *phoneSlot
	hs   *handshake
	// inv is set for a service-pair handshake: the invite instance that answered its message 1.
	inv *serviceInvite
}

// handshake is an admitted client or pairing handshake of a registration, tracked from before message 2 until the
// goroutine that accepted it is done (done closes then), so the registration's end and a list drop also close the
// ones whose key confirmation has not arrived. confirmed is guarded by serviceBook.mu.
type handshake struct {
	conn      relay.Conn
	key       string
	pairing   bool
	confirmed bool
	done      chan struct{}
}

// trackLocked records an admitted handshake on reg; serviceBook.mu is held.
func (reg *serviceReg) trackLocked(conn relay.Conn, key string, pairing bool) *handshake {
	hs := &handshake{conn: conn, key: key, pairing: pairing, done: make(chan struct{})}
	if reg.handshakes == nil {
		reg.handshakes = map[*handshake]struct{}{}
	}
	reg.handshakes[hs] = struct{}{}
	return hs
}

// handshakesLocked returns the connections of the matching handshakes that are not confirmed yet, to close, and the
// done signals of all matching ones, to wait for; serviceBook.mu is held.
func (reg *serviceReg) handshakesLocked(match func(*handshake) bool) (unconfirmed []relay.Conn, done []chan struct{}) {
	for hs := range reg.handshakes {
		if match(hs) {
			if !hs.confirmed {
				unconfirmed = append(unconfirmed, hs.conn)
			}
			done = append(done, hs.done)
		}
	}
	return unconfirmed, done
}

// confirmHandshake marks hs confirmed: from now on its session's own checks and close owner handle it.
func (b *serviceBook) confirmHandshake(hs *handshake) {
	b.mu.Lock()
	hs.confirmed = true
	b.mu.Unlock()
}

// leaveHandshake ends tracking hs once the goroutine that accepted it is done with it.
func (b *serviceBook) leaveHandshake(reg *serviceReg, hs *handshake) {
	b.mu.Lock()
	delete(reg.handshakes, hs)
	b.mu.Unlock()
	close(hs.done)
}

// closeHandshakes closes unconfirmed handshakes 4401 and waits until every handshake in done is finished.
func closeHandshakes(unconfirmed []relay.Conn, done []chan struct{}) {
	for _, c := range unconfirmed {
		c.Close(wire.CodeNotAdmitted)
	}
	for _, w := range done {
		<-w
	}
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
func (d *Daemon) admitClient(remote []byte, p session.Payload, conn relay.Conn) (clientAdmission, error) {
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
	slot, ok := d.svc.reservePhoneLocked(relayOf(conn), key)
	if !ok {
		return clientAdmission{}, errNotAdmitted
	}
	return clientAdmission{reg: reg, slot: slot, hs: reg.trackLocked(conn, key, false)}, nil
}

// admitPairing decides on a kind 0x03 service-pair handshake before message 2 (contract "Service invites"): the
// invite must be the live one of the registration holding the name, with budget left, and a phone slot must be free.
// It spends one answer of the budget with the slot and returns the invite's psk.
func (d *Daemon) admitPairing(remote []byte, p session.Payload, conn relay.Conn) (clientAdmission, []byte, error) {
	if !ValidServiceName(p.Name) || !validInviteID(p.Invite) {
		return clientAdmission{}, nil, errNotAdmitted
	}
	d.svc.mu.Lock()
	defer d.svc.mu.Unlock()
	now := d.now() // read under the lock, right before the expiry decision
	reg := d.svc.byName[p.Name]
	if reg == nil || reg.ended || reg.name != clientsService {
		return clientAdmission{}, nil, errNotAdmitted
	}
	inv := reg.invite
	if inv == nil || inv.id != p.Invite || inv.burned || !now.Before(inv.expires) || inv.budget < 1 {
		return clientAdmission{}, nil, errNotAdmitted
	}
	key := ident.B64.EncodeToString(remote)
	slot, ok := d.svc.reservePhoneLocked(relayOf(conn), key)
	if !ok {
		return clientAdmission{}, nil, errNotAdmitted
	}
	if inv.budget--; inv.budget == 0 {
		reg.out.push(jsonLine(map[string]any{"t": "invite-exhausted", "id": inv.id}))
	}
	return clientAdmission{reg: reg, slot: slot, inv: inv, hs: reg.trackLocked(conn, key, true)}, inv.psk, nil
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
	if d.opt.ClientRegistering != nil {
		d.opt.ClientRegistering()
	}
	if l.inv == nil && memberOrRevoked(d.view(), l.remote) {
		return false
	}
	d.svc.mu.Lock()
	now := d.now() // read under the lock, right before the burn's expiry decision
	ok := !l.reg.ended && d.svc.byName[l.reg.name] == l.reg
	if l.inv == nil {
		_, listed := l.reg.clients[l.remote]
		ok = ok && listed
	} else if inv := l.inv; ok && l.reg.invite == inv && !inv.burned && now.Before(inv.expires) {
		// The burn: one atomic step under serviceBook.mu (contract "Service invites").
		inv.burned = true
		l.reg.out.push(jsonLine(map[string]any{"t": "invite-burned", "id": inv.id}))
	} else {
		ok = false
	}
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
// line in progress; then it returns the session's phone slot and signals closed. The slot is held until here, so a
// session still closing keeps counting against the caps.
func (d *Daemon) closeOwned(l *live, code uint16) {
	if d.opt.ClientClosing != nil {
		d.opt.ClientClosing()
	}
	l.gate.Lock()
	if l.conn != nil {
		l.conn.Close()
	}
	l.sec.Close(code)
	l.gate.Unlock()
	d.mu.Lock()
	delete(d.sessions, l.k)
	d.mu.Unlock()
	if l.slot != nil {
		d.svc.releasePhone(l.slot)
	}
	if d.opt.ClientClosed != nil {
		d.opt.ClientClosed()
	}
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
// It runs once, by whoever calls it first (the registration's own end or its replacement); every other caller waits
// for it, so every caller returns only once it finished. reg must have ended.
func (d *Daemon) endRegistration(reg *serviceReg) {
	d.svc.mu.Lock()
	first := !reg.endStarted
	reg.endStarted = true
	conns := reg.endConns
	var unconfirmed []relay.Conn
	var handshakes []chan struct{}
	if first {
		reg.endConns = nil
		// No handshake joins an ended registration, so this is all of them.
		unconfirmed, handshakes = reg.handshakesLocked(func(*handshake) bool { return true })
	}
	d.svc.mu.Unlock()
	if !first {
		if d.opt.RegistrationJoining != nil {
			d.opt.RegistrationJoining(reg.id)
		}
		<-reg.endDone
		return
	}
	if d.opt.RegistrationEnding != nil {
		d.opt.RegistrationEnding()
	}
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
	closeHandshakes(unconfirmed, handshakes)
	close(reg.endDone)
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
	l := &live{remote: ident.B64.EncodeToString(sec.RemoteStatic), sec: sec, client: true, reg: a.reg, inv: a.inv,
		slot: a.slot, closed: make(chan struct{})}
	if !d.registerClient(l) {
		sec.Close(wire.CodeNotAdmitted)
		if a.slot != nil {
			d.svc.releasePhone(a.slot)
		}
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
	if l.inv == nil && memberOrRevoked(v, l.remote) {
		return nil, failed(causeReplaced, errors.New("the client key is now a member's"))
	}
	d.svc.mu.Lock()
	id, listed := reg.clients[l.remote]
	if l.inv != nil {
		listed = true // a pairing session belongs to its burned invite, never to the list
	}
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
	var j []byte
	var err error
	if l.inv != nil {
		sas := ident.B64.EncodeToString(session.PairSAS(l.sec.HandshakeHash))
		j, err = pairingIdentityLine(v.MeshID, d.nodeID, l.inv.id, l.remote, sas, reg.name)
	} else {
		j, err = clientIdentityLine(v.MeshID, d.nodeID, id, l.remote, reg.name)
	}
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
		return l.reg == reg && l.inv == nil && !kept
	})
}
