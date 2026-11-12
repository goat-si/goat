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
		case "service":
			if !ValidServiceName(p.Name) {
				return nil, errNotAdmitted
			}
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
	var client *clientAdmission
	admit := func(kind byte, remote []byte, p session.Payload) ([]byte, error) {
		if kind == session.KindJoin && p.Stream == "service-pair" {
			a, psk, err := d.admitPairing(remote, p, c)
			if err == nil {
				client = &a
			}
			return psk, err
		}
		if _, member := d.view().MemberByNoise(remote); kind == session.KindSession && !member {
			a, err := d.admitClient(remote, p, c)
			if err == nil {
				client = &a
			}
			return nil, err
		}
		if kind == session.KindAccount && d.svc.listedAnywhere(ident.B64.EncodeToString(remote)) {
			return nil, errNotAdmitted
		}
		psk, err := d.admit(kind, remote, p)
		if err != nil || kind != session.KindAccount {
			return psk, err
		}
		slot, err = d.reserveAccount(c)
		return nil, err
	}
	hctx := ctx
	if d.opt.HandshakeContext != nil {
		hctx = d.opt.HandshakeContext(ctx)
	}
	sec, err := session.Respond(hctx, c, d.id, d.nodeID, admit)
	if client != nil {
		// Tracked on its registration until serveClient registers or refuses its session, or, for a handshake that
		// fails, until this goroutine is done with it (deferred first, so it runs last).
		defer d.svc.leaveHandshake(client.reg, client.hs)
		if err == nil {
			d.svc.confirmHandshake(client.hs)
			if d.opt.ClientConfirmed != nil {
				d.opt.ClientConfirmed()
			}
		}
	}
	if err != nil && client != nil && client.slot != nil {
		// Taken before message 2; a handshake that did not confirm returns it here. A confirmed session's slot is
		// returned by serveClient or by the owner of its close.
		d.svc.releasePhone(client.slot)
	}
	if slot != nil {
		defer d.releaseAccount(slot)
	}
	if err != nil {
		return
	}
	if client != nil {
		if d.opt.ClientEnded != nil {
			defer d.opt.ClientEnded()
		}
		d.serveClient(ctx, sec, *client)
		return
	}
	switch sec.Payload.Stream {
	case "tcp", "mesh", "service":
		// The peer may have been revoked between message 1 and its confirmation.
		l := &live{remote: ident.B64.EncodeToString(sec.RemoteStatic), sec: sec}
		k, ok := d.register(l)
		if !ok {
			sec.Close(wire.CodeNotAdmitted)
			return
		}
		defer d.unregister(k)
		d.markSeen(sec.RemoteStatic, true, relayOf(c))
		switch sec.Payload.Stream {
		case "tcp":
			d.serveTCP(ctx, sec, relayOf(c))
		case "service":
			d.serveService(ctx, sec)
		default:
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

// relayOf is the relay whose uplink carried c.
func relayOf(c relay.Conn) string {
	if r, ok := c.(interface{ Relay() string }); ok {
		return r.Relay()
	}
	return ""
}

func (d *Daemon) serveTCP(ctx context.Context, sec *session.Secure, relayURL string) {
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
	if err := stream.Splice(ctx, d.meterAccepted(sec, relayURL), tc, tc, tc.CloseWrite); err != nil && !stream.Delivered(err) {
		// The peer's stream stopped short of its FIN: the service reads a reset, not a clean end.
		tc.SetLinger(0)
	}
}

func (d *Daemon) serveMesh(ctx context.Context, sec *session.Secure, l *live) {
	ctx, cancel := context.WithTimeout(ctx, meshSessionTimeout)
	defer cancel()
	merged := func(added []*mesh.Record) error {
		// Records on this session that remove its own peer: keep it open until our done so the
		// peer learns its push was taken. Every other session of a revoked key closes at once.
		if d.carriesPeerRevoke(sec.RemoteStatic, added) {
			d.mu.Lock()
			l.deferred = true
			d.mu.Unlock()
		}
		return d.onMerged(added)
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
