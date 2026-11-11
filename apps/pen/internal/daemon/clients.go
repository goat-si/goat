package daemon

import (
	"context"
	"errors"
	"net"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/session"
	"github.com/goat-si/goat/apps/pen/internal/stream"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// clientAdmission is what message 1 of a session from a key that is not a member was admitted under (contract
// "Admission of client keys"): the registration whose list named the key.
type clientAdmission struct {
	reg *serviceReg
}

// admitClient decides on a kind 0x01 service stream from a key that is not a member, before message 2.
func (d *Daemon) admitClient(remote []byte, p session.Payload) (clientAdmission, error) {
	if p.Stream != "service" || !ValidServiceName(p.Name) {
		return clientAdmission{}, errNotAdmitted
	}
	key := ident.B64.EncodeToString(remote)
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

// registerClient records a confirmed client session if its registration is still current and still lists its key.
func (d *Daemon) registerClient(l *live) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
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

// serveClient delivers a confirmed client session to the program that holds its service name.
func (d *Daemon) serveClient(ctx context.Context, sec *session.Secure, a clientAdmission) {
	l := &live{remote: ident.B64.EncodeToString(sec.RemoteStatic), sec: sec, client: true, reg: a.reg}
	if !d.registerClient(l) {
		sec.Close(wire.CodeNotAdmitted)
		return
	}
	defer d.unregister(l.k)
	if !d.svc.acquire() {
		sec.Close(wire.CodeCaps)
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
	reg := d.svc.lookup(sec.Payload.Name)
	if reg == nil {
		sec.Close(wire.CodeOffline)
		return
	}
	conn, err := d.deliverTo(ctx, reg, sec.RemoteStatic, l)
	if err != nil {
		d.logDelivery(reg, err)
		sec.Close(wire.CodeOffline)
		return
	}
	defer conn.Close()
	defer d.svc.uncommit(reg, conn)
	releaseSlot()
	stream.Splice(ctx, sec, conn, conn, conn.CloseWrite)
}

// clientLine commits a client delivery and renders its identity line.
func (d *Daemon) clientLine(reg *serviceReg, tc net.Conn, l *live) ([]byte, error) {
	if !d.svc.commit(reg, tc) {
		return nil, failed(causeReplaced, errors.New("the registration ended during the delivery"))
	}
	d.svc.mu.Lock()
	id := reg.clients[l.remote]
	d.svc.mu.Unlock()
	j, err := clientIdentityLine(d.view().MeshID, d.nodeID, id, l.remote, reg.name)
	if err != nil {
		d.svc.uncommit(reg, tc)
		return nil, failed(causeMalformed, err)
	}
	return j, nil
}
