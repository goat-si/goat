package daemon

import (
	"context"
	"errors"
	"slices"
	"sort"
	"sync"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/session"
	"github.com/goat-si/goat/apps/pen/internal/state"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

const pushTimeout = 30 * time.Second

// PushResult is one member's answer to a push.
type PushResult struct {
	NodeID string `json:"nodeId"`
	Name   string `json:"name"`
	// Result is taken, offline, refused or an error text.
	Result string `json:"result"`
}

// pushAll syncs with every other member concurrently.
func (d *Daemon) pushAll(ctx context.Context) []PushResult {
	return d.pushTo(ctx, d.view().SortedMembers())
}

func (d *Daemon) pushTo(ctx context.Context, members []mesh.Member) []PushResult {
	d.retrySave()
	limit := pushTimeout
	if d.opt.PushTimeout > 0 {
		limit = d.opt.PushTimeout
	}
	return d.pushWithin(ctx, members, limit)
}

// pushWithin pushes to members, each within limit; a push that runs out of limit marks its member
// offline, while one that ctx ends leaves it as it was.
func (d *Daemon) pushWithin(ctx context.Context, members []mesh.Member, limit time.Duration) []PushResult {
	var wg sync.WaitGroup
	var mu sync.Mutex
	var out []PushResult
	for _, m := range members {
		if m.NodeID == d.nodeID {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			res := d.push(ctx, m, limit)
			mu.Lock()
			out = append(out, PushResult{NodeID: m.NodeID, Name: m.Name, Result: res})
			mu.Unlock()
		}()
	}
	wg.Wait()
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func (d *Daemon) push(ctx context.Context, m mesh.Member, limit time.Duration) string {
	caller := ctx
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	noise, err := ident.DecodeKey(m.NoisePub)
	if err != nil {
		return "error: bad member key"
	}
	res := func(err error) string {
		// The caller ran out of time (the 5 s refresh before a Google admit): a slow member is
		// not an absent one.
		if caller.Err() != nil {
			return "error: " + err.Error()
		}
		switch relay.CodeOf(err) {
		case wire.CodeOffline:
			d.markSeen(noise, false, "")
			return "offline"
		case wire.CodeNotAdmitted:
			return "refused"
		case wire.CodeCaps:
			// The relay's own limits (pending, admission): busy, not the member's mesh.
			return "not taken: the relay is busy (4429); it syncs again within 10 minutes"
		case wire.CodeMeshFull:
			return "not taken: its mesh is full (4508)"
		case wire.CodeEpoch:
			return "not taken: it runs an older Pen than this mesh needs (4509)"
		case wire.CodeNotKept:
			return "not taken: it cannot write its state folder (4507)"
		}
		// A sleeping machine's uplink can stay registered at the relay, so its dials time out
		// instead of closing 4404; a failed sync means it is not reachable now either way.
		d.markSeen(noise, false, "")
		return "error: " + err.Error()
	}
	sec, used, err := openMemberVia(ctx, d.relays(), d.id, m.NodeID, noise, session.Payload{V: 1, Stream: "mesh"})
	if err != nil {
		return res(err)
	}
	defer sec.Close(wire.CodeNormal)
	if err := mesh.SyncInitiateAs(ctx, sec, d.mesh(), d.onMerged, d.helloFrom(noise), d.announce()); err != nil {
		return res(err)
	}
	d.markSeen(noise, true, used)
	return "taken"
}

// DialRetries is how often a join retries a relay 4404 (the inviter's uplink may be registering).
var DialRetries = []time.Duration{300 * time.Millisecond, time.Second, 2 * time.Second}

// OpenAny reaches nodeID through the first of relays to answer (DialRace) and runs handshake on it,
// for kinds 0x03 and 0x04 (kind 0x01 races the handshake itself, OpenSession). A relay can answer
// pong for a stale uplink, so when the handshake fails there it falls back to the remaining relays;
// 4401 and 4400 are the node's answer and end the attempt.
func OpenAny(ctx context.Context, relays []string, nodeID string, handshake func(relay.Conn) (*session.Secure, error)) (*session.Secure, error) {
	left := append([]string(nil), relays...)
	var last error
	for len(left) > 0 {
		conn, used, err := relay.DialRace(ctx, left, nodeID)
		if err != nil {
			if last != nil {
				return nil, last
			}
			return nil, err
		}
		sec, err := handshake(conn)
		if err == nil {
			return sec, nil
		}
		conn.Close(wire.CodeNormal)
		if code := relay.CodeOf(err); code == wire.CodeNotAdmitted || code == wire.CodeCrypto || ctx.Err() != nil {
			return nil, err
		}
		last = err
		left = slices.DeleteFunc(left, func(u string) bool { return u == used })
	}
	return nil, last
}

// OpenTCP opens a kind 0x01 tcp stream to port on member m and returns the confirmed session.
func OpenTCP(ctx context.Context, relays []string, id *ident.Identity, m mesh.Member, port int) (*session.Secure, error) {
	sec, _, err := OpenTCPVia(ctx, relays, id, m, port)
	return sec, err
}

// OpenTCPVia is OpenTCP that also names the relay the session runs on.
func OpenTCPVia(ctx context.Context, relays []string, id *ident.Identity, m mesh.Member, port int) (*session.Secure, string, error) {
	noise, err := ident.DecodeKey(m.NoisePub)
	if err != nil {
		return nil, "", err
	}
	return openMemberVia(ctx, relays, id, m.NodeID, noise, session.Payload{V: 1, Stream: "tcp", Port: port})
}

// OpenService opens a kind 0x01 service stream for name on member m and returns the confirmed session.
func OpenService(ctx context.Context, relays []string, id *ident.Identity, m mesh.Member, name string) (*session.Secure, error) {
	sec, _, err := OpenServiceVia(ctx, relays, id, m, name)
	return sec, err
}

// OpenServiceVia is OpenService that also names the relay the session runs on.
func OpenServiceVia(ctx context.Context, relays []string, id *ident.Identity, m mesh.Member, name string) (*session.Secure, string, error) {
	noise, err := ident.DecodeKey(m.NoisePub)
	if err != nil {
		return nil, "", err
	}
	return openMemberVia(ctx, relays, id, m.NodeID, noise, session.Payload{V: 1, Stream: "service", Name: name})
}

// Join runs the joiner side of tok against its relay and returns the verified set (not yet saved).
func Join(ctx context.Context, st *state.Store, id *ident.Identity, tok mesh.Token, name string) (*mesh.Store, error) {
	nodeID := tok.NodeID()
	psk, err := session.JoinPSK(tok.Secret, nodeID, tok.NoisePub)
	if err != nil {
		return nil, err
	}
	payload := session.Payload{V: 1, Stream: "join", Invite: session.InviteID(tok.Secret), Name: name}
	var sec *session.Secure
	for attempt := 0; ; attempt++ {
		sec, err = OpenAny(ctx, tok.Relays, nodeID, func(conn relay.Conn) (*session.Secure, error) {
			return session.Initiate(ctx, conn, session.KindJoin, nodeID, tok.NoisePub, id, psk, payload)
		})
		if err == nil {
			break
		}
		if relay.CodeOf(err) != wire.CodeOffline || attempt >= len(DialRetries) {
			return nil, joinError(err)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(DialRetries[attempt]):
		}
	}
	meshID, recs, err := mesh.Join(ctx, sec, id, name)
	if err != nil {
		return nil, joinError(err)
	}
	sec.Close(wire.CodeNormal)
	return mesh.CheckJoined(st, id, meshID, recs)
}

func joinError(err error) error {
	var refused *mesh.RefusedError
	if errors.As(err, &refused) && refused.NotMember {
		return errors.New("the inviting machine is no longer a member of its mesh, so it cannot add this one; the invite was not used. Ask a current member for a new invite")
	}
	if errors.As(err, &refused) {
		return err
	}
	switch relay.CodeOf(err) {
	case wire.CodeOffline:
		return errors.New("the inviting node is offline (4404)")
	case wire.CodeNotAdmitted:
		return errors.New("the invite is unknown, expired or already used (4401)")
	case wire.CodeCrypto:
		return errors.New("handshake failed; the token does not match the inviting node (4400)")
	}
	return err
}
