package daemon

import (
	"context"
	"net"
	"strconv"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/session"
	"github.com/goat-si/goat/apps/pen/internal/stream"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

const meshSessionTimeout = 2 * time.Minute

var errNotAdmitted = &relay.CloseError{Code: wire.CodeNotAdmitted}

func (d *Daemon) acceptLoop(ctx context.Context) {
	for {
		c, err := d.up.Accept(ctx)
		if err != nil {
			return
		}
		d.spawn(func() { d.handleOpen(ctx, c) })
	}
}

// admit is the responder's decision after message 1 (contract "Admission").
func (d *Daemon) admit(kind byte, remote []byte, p session.Payload) ([]byte, error) {
	switch kind {
	case session.KindSession:
		if _, ok := d.view().MemberByNoise(remote); !ok {
			return nil, errNotAdmitted
		}
		switch p.Stream {
		case "tcp":
			if p.Port < 1 || p.Port > 65535 {
				return nil, errNotAdmitted
			}
		case "mesh":
		default:
			return nil, errNotAdmitted
		}
		return nil, nil
	case session.KindJoin:
		if p.Stream != "join" {
			return nil, errNotAdmitted
		}
		inv, ok := d.invites.Lookup(p.Invite, d.now())
		if !ok {
			return nil, errNotAdmitted
		}
		return session.JoinPSK(inv.Secret, d.nodeID, d.id.NoisePub)
	}
	return nil, errNotAdmitted
}

func (d *Daemon) handleOpen(ctx context.Context, c relay.Conn) {
	sec, err := session.Respond(ctx, c, d.id, d.nodeID, d.admit)
	if err != nil {
		return
	}
	switch sec.Payload.Stream {
	case "tcp":
		d.markSeen(sec.RemoteStatic, true)
		k := d.register(&live{remote: ident.B64.EncodeToString(sec.RemoteStatic), sec: sec})
		defer d.unregister(k)
		d.serveTCP(ctx, sec)
	case "mesh":
		d.markSeen(sec.RemoteStatic, true)
		k := d.register(&live{remote: ident.B64.EncodeToString(sec.RemoteStatic), sec: sec, deferred: true})
		defer d.unregister(k)
		d.serveMesh(ctx, sec)
	case "join":
		d.serveJoin(ctx, sec)
	default:
		sec.Close(wire.CodeNotAdmitted)
	}
}

func (d *Daemon) serveTCP(ctx context.Context, sec *session.Secure) {
	var dialer net.Dialer
	dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	conn, err := dialer.DialContext(dctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(sec.Payload.Port)))
	cancel()
	if err != nil {
		sec.Close(wire.CodeOffline)
		return
	}
	tc := conn.(*net.TCPConn)
	defer tc.Close()
	stream.Splice(ctx, sec, tc, tc, tc.CloseWrite)
}

func (d *Daemon) serveMesh(ctx context.Context, sec *session.Secure) {
	ctx, cancel := context.WithTimeout(ctx, meshSessionTimeout)
	defer cancel()
	if err := mesh.SyncRespond(ctx, sec, d.mesh(), d.onMerged); err != nil {
		if relay.CodeOf(err) == 0 {
			sec.Close(wire.CodeTimeout)
		}
		return
	}
	code := wire.CodeNormal
	if _, ok := d.view().MemberByNoise(sec.RemoteStatic); !ok {
		code = wire.CodeNotAdmitted
	}
	sec.Close(code)
}

func (d *Daemon) serveJoin(ctx context.Context, sec *session.Secure) {
	ctx, cancel := context.WithTimeout(ctx, meshSessionTimeout)
	defer cancel()
	inviteID := sec.Payload.Invite
	joiner := ident.B64.EncodeToString(sec.RemoteStatic)
	member, err := mesh.ServeJoin(ctx, sec, sec.RemoteStatic, mesh.Admission{
		ID: d.id, Store: d.mesh(), Invites: d.invites, InviteID: inviteID, Now: d.now,
		// The other members hear of the joiner before its join returns.
		OnAdmit: func(*mesh.Record) {
			d.viewChanged()
			var others []mesh.Member
			for _, m := range d.view().SortedMembers() {
				if m.NoisePub != joiner {
					others = append(others, m)
				}
			}
			d.pushTo(ctx, others)
		},
	})
	if err != nil {
		d.opt.Logf("join: %v", err)
		return
	}
	d.opt.Logf("admitted %s (%s)", member.Name, member.NodeID)
	d.mu.Lock()
	if ch := d.inviteWait[inviteID]; ch != nil {
		ch <- *member
		delete(d.inviteWait, inviteID)
	}
	d.mu.Unlock()
	sec.Close(wire.CodeNormal)
}

