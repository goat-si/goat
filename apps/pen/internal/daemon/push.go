package daemon

import (
	"context"
	"errors"
	"fmt"
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
			res := d.push(ctx, m)
			mu.Lock()
			out = append(out, PushResult{NodeID: m.NodeID, Name: m.Name, Result: res})
			mu.Unlock()
		}()
	}
	wg.Wait()
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func (d *Daemon) push(ctx context.Context, m mesh.Member) string {
	ctx, cancel := context.WithTimeout(ctx, pushTimeout)
	defer cancel()
	noise, err := ident.DecodeKey(m.NoisePub)
	if err != nil {
		return "error: bad member key"
	}
	res := func(err error) string {
		switch relay.CodeOf(err) {
		case wire.CodeOffline:
			d.markSeen(noise, false)
			return "offline"
		case wire.CodeNotAdmitted:
			return "refused"
		}
		return "error: " + err.Error()
	}
	conn, err := relay.Dial(ctx, d.relayURL(), m.NodeID)
	if err != nil {
		return res(err)
	}
	sec, err := session.Initiate(ctx, conn, session.KindSession, m.NodeID, noise, d.id, nil, session.Payload{V: 1, Stream: "mesh"})
	if err != nil {
		conn.Close(wire.CodeNormal)
		return res(err)
	}
	defer sec.Close(wire.CodeNormal)
	if err := mesh.SyncInitiate(ctx, sec, d.mesh(), d.onMerged); err != nil {
		return res(err)
	}
	d.markSeen(noise, true)
	return "taken"
}

// DialRetries is how often a join retries a relay 4404 (the inviter's uplink may be registering).
var DialRetries = []time.Duration{300 * time.Millisecond, time.Second, 2 * time.Second}

// OpenTCP opens a kind 0x01 tcp stream to port on member m and returns the confirmed session.
func OpenTCP(ctx context.Context, relayURL string, id *ident.Identity, m mesh.Member, port int) (*session.Secure, error) {
	noise, err := ident.DecodeKey(m.NoisePub)
	if err != nil {
		return nil, err
	}
	conn, err := relay.Dial(ctx, relayURL, m.NodeID)
	if err != nil {
		return nil, fmt.Errorf("relay: %w", err)
	}
	sec, err := session.Initiate(ctx, conn, session.KindSession, m.NodeID, noise, id, nil, session.Payload{V: 1, Stream: "tcp", Port: port})
	if err != nil {
		conn.Close(wire.CodeNormal)
		return nil, err
	}
	return sec, nil
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
		conn, err := relay.Dial(ctx, tok.Relay, nodeID)
		if err != nil {
			return nil, fmt.Errorf("relay: %w", err)
		}
		sec, err = session.Initiate(ctx, conn, session.KindJoin, nodeID, tok.NoisePub, id, psk, payload)
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
