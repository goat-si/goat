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
		var c relay.Conn
		select {
		case c = <-d.accept:
		case <-ctx.Done():
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
		inv, ok := d.inviteBook().Lookup(p.Invite, d.now())
		if !ok {
			return nil, errNotAdmitted
		}
		return session.JoinPSK(inv.Secret, d.nodeID, d.id.NoisePub)
	case session.KindAccount:
		if p.Stream != "account" || !ident.ValidName(p.Name) {
			return nil, errNotAdmitted
		}
		return nil, nil
	}
	return nil, errNotAdmitted
}

func (d *Daemon) handleOpen(ctx context.Context, c relay.Conn) {
	var slot *acctSlot
	admit := func(kind byte, remote []byte, p session.Payload) ([]byte, error) {
		psk, err := d.admit(kind, remote, p)
		if err != nil || kind != session.KindAccount {
			return psk, err
		}
		slot, err = d.reserveAccount(c)
		return nil, err
	}
	sec, err := session.Respond(ctx, c, d.id, d.nodeID, admit)
	if slot != nil {
		defer d.releaseAccount(slot)
	}
	if err != nil {
		return
	}
	switch sec.Payload.Stream {
	case "tcp", "mesh":
		// The peer may have been revoked between message 1 and its confirmation.
		l := &live{remote: ident.B64.EncodeToString(sec.RemoteStatic), sec: sec}
		k, ok := d.register(l)
		if !ok {
			sec.Close(wire.CodeNotAdmitted)
			return
		}
		defer d.unregister(k)
		d.markSeen(sec.RemoteStatic, true)
		if sec.Payload.Stream == "tcp" {
			d.serveTCP(ctx, sec)
		} else {
			d.serveMesh(ctx, sec, l)
		}
	case "join":
		d.serveJoin(ctx, sec)
	case "account":
		d.serveAccount(ctx, sec, slot)
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

func (d *Daemon) serveMesh(ctx context.Context, sec *session.Secure, l *live) {
	ctx, cancel := context.WithTimeout(ctx, meshSessionTimeout)
	defer cancel()
	merged := func(added []*mesh.Record) {
		// Records on this session that remove its own peer: keep it open until our done so the
		// peer learns its push was taken. Every other session of a revoked key closes at once.
		if d.carriesPeerRevoke(sec.RemoteStatic, added) {
			d.mu.Lock()
			l.deferred = true
			d.mu.Unlock()
		}
		d.onMerged(added)
	}
	if err := mesh.SyncRespondAs(ctx, sec, d.mesh(), merged, d.helloFrom(sec.RemoteStatic), d.announce()); err != nil {
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
		ID: d.id, Store: d.mesh(), Invites: d.inviteBook(), InviteID: inviteID, Now: d.now,
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

// carriesPeerRevoke reports whether a batch merged on a peer's own session holds that peer's revoke:
// a revoke naming it, or a compromised revoke after which it is no longer a member. A revoke that
// arrived on another session does not count, so this session still closes at once.
func (d *Daemon) carriesPeerRevoke(peerNoise []byte, added []*mesh.Record) bool {
	v := d.view()
	if _, member := v.MemberByNoise(peerNoise); member {
		return false
	}
	peer := ""
	noise := ident.B64.EncodeToString(peerNoise)
	for k, m := range v.Revoked {
		if m.NoisePub == noise {
			peer = k
		}
	}
	for _, r := range added {
		if r.B.Type != mesh.TypeRevoke {
			continue
		}
		if r.B.Compromised != nil && *r.B.Compromised {
			return true
		}
		for _, s := range r.B.Subjects {
			if s == peer {
				return true
			}
		}
	}
	return false
}
