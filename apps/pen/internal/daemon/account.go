package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/login"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/session"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// MaxAccountSessions caps concurrent kind 0x04 sessions on a member.
const MaxAccountSessions = 4

// acctSlot is one running kind 0x04 session; asserted ones are no longer evictable.
type acctSlot struct {
	conn     relay.Conn
	asserted bool
}

var errCaps = &relay.CloseError{Code: wire.CodeCaps}

// reserveAccount counts a kind 0x04 session; a fifth evicts the oldest that sent no assertion (4429).
func (d *Daemon) reserveAccount(c relay.Conn) (*acctSlot, error) {
	d.mu.Lock()
	var victim *acctSlot
	if len(d.acct) >= MaxAccountSessions {
		for i, s := range d.acct {
			if !s.asserted {
				victim = s
				d.acct = append(d.acct[:i:i], d.acct[i+1:]...)
				break
			}
		}
		if victim == nil {
			d.mu.Unlock()
			return nil, errCaps
		}
	}
	slot := &acctSlot{conn: c}
	d.acct = append(d.acct, slot)
	d.mu.Unlock()
	if victim != nil {
		victim.conn.Close(wire.CodeCaps)
	}
	return slot, nil
}

func (d *Daemon) releaseAccount(slot *acctSlot) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for i, s := range d.acct {
		if s == slot {
			d.acct = append(d.acct[:i:i], d.acct[i+1:]...)
			return
		}
	}
}

// binding is the view's account binding in login form.
func binding(v *mesh.View) (login.Binding, bool) {
	if v.Account == nil {
		return login.Binding{}, false
	}
	a := v.Account
	return login.Binding{LoginURL: a.LoginURL, Key: login.Key{Kid: a.LoginKey.Kid, Pub: a.LoginKey.Pub}, Sub: a.Sub}, true
}

// checkAssertion is a member's decision on an account joiner's assertion (contract "Account join").
func (d *Daemon) checkAssertion(raw json.RawMessage, v *mesh.View) (mesh.Claim, error) {
	b, ok := binding(v)
	if !ok {
		return mesh.Claim{}, errors.New("this mesh is not bound to a Google account")
	}
	var a login.Assertion
	if err := json.Unmarshal(raw, &a); err != nil {
		return mesh.Claim{}, errors.New("malformed assertion")
	}
	if err := a.Check(b, d.now()); err != nil {
		return mesh.Claim{}, err
	}
	if _, gone := v.Revoked[a.A.SignPub]; gone {
		return mesh.Claim{}, errors.New("this key was revoked")
	}
	if d.pending.isDenied(a.A.SignPub, d.now()) {
		return mesh.Claim{}, errors.New("a member denied this machine; it may ask again after 24 hours")
	}
	return mesh.Claim{SignPub: a.A.SignPub, NoisePub: a.A.NoisePub, Email: a.A.Email, Sub: a.A.Sub, Hash: a.Hash()}, nil
}

// queueRequest keeps an account join while the mesh is locked.
func (d *Daemon) queueRequest(card *mesh.Card, c mesh.Claim) (string, error) {
	noise, err := ident.DecodeKey(card.C.NoisePub)
	if err != nil {
		return "", err
	}
	fp := ident.Fingerprint(noise)
	p := Pending{ID: fp[:9], Fingerprint: fp, Name: card.C.Name, NodeID: card.C.NodeID, SignPub: card.C.SignPub,
		Email: c.Email, Sub: c.Sub, Assertion: c.Hash, At: d.now().UnixMilli(), Card: card}
	if err := d.pending.add(p, d.now()); err != nil {
		return "", err
	}
	d.opt.Logf("queued %s (%s, %s); approve with: pen approve '%s'", p.Name, p.Email, fp, fp)
	return p.ID, nil
}

func (d *Daemon) serveAccount(ctx context.Context, sec *session.Secure, slot *acctSlot) {
	ctx, cancel := context.WithTimeout(ctx, meshSessionTimeout)
	defer cancel()
	joiner := ident.B64.EncodeToString(sec.RemoteStatic)
	res, err := mesh.ServeAccount(ctx, sec, sec.RemoteStatic, mesh.AccountAdmission{
		ID: d.id, Store: d.mesh(), Now: d.now, Wait: d.opt.AccountWait,
		Asserted: func() {
			d.mu.Lock()
			slot.asserted = true
			d.mu.Unlock()
		},
		Check: d.checkAssertion,
		Queue: d.queueRequest,
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
		d.opt.Logf("account join: %v", err)
		return
	}
	if res.Admitted != nil {
		d.opt.Logf("admitted %s (%s) via Google %s", res.Admitted.Name, res.Admitted.NodeID, res.Admitted.Email)
		sec.Close(wire.CodeNormal)
	}
}

// ApproveResult is what approve answers.
type ApproveResult struct {
	Member  mesh.Member  `json:"member"`
	Results []PushResult `json:"results"`
}

// approve admits a queued request (by full fingerprint, or an id one request matches).
func (d *Daemon) approve(ctx context.Context, arg string) (ApproveResult, error) {
	p, err := d.pending.find(arg, d.now())
	if err != nil {
		return ApproveResult{}, err
	}
	v := d.view()
	if v.Account == nil || v.Account.Sub != p.Sub {
		return ApproveResult{}, errors.New("the mesh is no longer bound to the account this request signed in with")
	}
	if _, gone := v.Revoked[p.SignPub]; gone {
		return ApproveResult{}, errors.New("this key was revoked")
	}
	m, err := mesh.AdmitAccount(d.id, d.mesh(), p.Card, mesh.Claim{SignPub: p.SignPub, NoisePub: p.Card.C.NoisePub, Email: p.Email, Hash: p.Assertion}, d.now())
	if err != nil {
		return ApproveResult{}, err
	}
	if err := d.pending.remove(p, false, d.now()); err != nil {
		return ApproveResult{}, err
	}
	d.viewChanged()
	return ApproveResult{Member: m.Member, Results: d.pushAll(ctx)}, nil
}

// deny drops a queued request and refuses its key for 24 hours.
func (d *Daemon) deny(arg string) (Pending, error) {
	p, err := d.pending.find(arg, d.now())
	if err != nil {
		return Pending{}, err
	}
	return p, d.pending.remove(p, true, d.now())
}

// requireV11 syncs with every member and refuses unless each announced pen 1.1 in a hello of this
// round: an announcement lasts only for its session, so a member that came back older counts as
// older (contract "Mesh records": v1.0 nodes reject account and lock records and would stall).
func (d *Daemon) requireV11(ctx context.Context, what string) error {
	d.mu.Lock()
	since := d.helloSeq
	d.mu.Unlock()
	d.pushAll(ctx)
	v := d.view()
	d.mu.Lock()
	var missing []string
	for _, m := range v.SortedMembers() {
		if h := d.versions[m.NoisePub]; m.NodeID != d.nodeID && (h.seq <= since || h.pen != mesh.Version) {
			missing = append(missing, m.Name)
		}
	}
	d.mu.Unlock()
	if len(missing) > 0 {
		return fmt.Errorf("every member must run pen 1.1 before %s; not confirmed now: %s (offline or older)", what, strings.Join(missing, ", "))
	}
	return nil
}

// bindAccount signs an account record (nil unbinds) and pushes it, once every member runs pen 1.1.
func (d *Daemon) bindAccount(ctx context.Context, acct *mesh.Account) ([]PushResult, error) {
	cur := d.view().Account
	if acct == nil && cur == nil || acct != nil && cur != nil && *acct == *cur {
		return nil, nil
	}
	if err := d.requireV11(ctx, "the mesh's account binding changes"); err != nil {
		return nil, err
	}
	if _, err := d.mesh().Append(d.id, mesh.TypeAccount, d.now().UnixMilli(), mesh.Fields{Bind: acct}); err != nil {
		return nil, err
	}
	d.viewChanged()
	return d.pushAll(ctx), nil
}

// setLock signs a lock record and pushes it, once every member runs pen 1.1.
func (d *Daemon) setLock(ctx context.Context, on bool) ([]PushResult, error) {
	if d.view().Locked == on {
		return nil, nil
	}
	if err := d.requireV11(ctx, "lock mode changes"); err != nil {
		return nil, err
	}
	if _, err := d.mesh().Append(d.id, mesh.TypeLock, d.now().UnixMilli(), mesh.Fields{On: on}); err != nil {
		return nil, err
	}
	d.viewChanged()
	if d.view().Locked != on {
		return nil, errors.New("the lock record had no effect (a lock signed elsewhere is not in its past yet; sync and try again)")
	}
	return d.pushAll(ctx), nil
}

// forgetRevoked tells the login service to drop keys this view revokes (contract "Login service").
func (d *Daemon) forgetRevoked(old, v *mesh.View) {
	b, ok := binding(v)
	if !ok || old == nil {
		return
	}
	var gone []string
	for k, m := range v.Revoked {
		// This node's own revoke is a leave, which forgets it in line before the keys go.
		if _, was := old.Revoked[k]; !was && m.NodeID != "" && m.NodeID != d.nodeID {
			gone = append(gone, m.NodeID)
		}
	}
	if len(gone) == 0 {
		return
	}
	var fs []PendingForget
	for _, nodeID := range gone {
		fs = append(fs, PendingForget{NodeID: nodeID, LoginURL: b.LoginURL})
	}
	if err := d.forgets.add(fs); err != nil {
		d.opt.Logf("forgets.json: %v", err)
	}
}

// ErrNoMemberOnline means none of the offered members answered.
var ErrNoMemberOnline = errors.New("no member online yet")

// AccountJoin races the offered members for a kind 0x04 session and runs the join on the first
// that answers. It returns the outcome and the member that served it.
func AccountJoin(ctx context.Context, relays []string, id *ident.Identity, name string, a *login.Assertion, members []login.OfferedMember) (mesh.AccountOutcome, login.OfferedMember, error) {
	raw, err := json.Marshal(a)
	if err != nil {
		return mesh.AccountOutcome{}, login.OfferedMember{}, err
	}
	type won struct {
		sec *session.Secure
		m   login.OfferedMember
		err error
	}
	rctx, cancel := context.WithCancel(ctx)
	defer cancel()
	results := make(chan won, len(members))
	n := 0
	for _, m := range members {
		noise, err := ident.DecodeKey(m.NoisePub)
		if err != nil || m.NodeID == id.NodeID() || !ident.ValidNodeID(m.NodeID) {
			continue
		}
		n++
		go func() {
			sec, err := OpenAny(rctx, relays, m.NodeID, func(conn relay.Conn) (*session.Secure, error) {
				return session.Initiate(rctx, conn, session.KindAccount, m.NodeID, noise, id, nil, session.Payload{V: 1, Stream: "account", Name: name})
			})
			results <- won{sec, m, err}
		}()
	}
	var first *won
	var errs []error
	var wg sync.WaitGroup
	for range n {
		r := <-results
		if r.err != nil {
			errs = append(errs, r.err)
			continue
		}
		if first == nil {
			first = &r
			cancel()
			continue
		}
		wg.Add(1)
		go func() { defer wg.Done(); r.sec.Close(wire.CodeNormal) }()
	}
	wg.Wait()
	if first == nil {
		for _, err := range errs {
			if relay.CodeOf(err) != wire.CodeOffline {
				return mesh.AccountOutcome{}, login.OfferedMember{}, joinError(err)
			}
		}
		return mesh.AccountOutcome{}, login.OfferedMember{}, ErrNoMemberOnline
	}
	defer first.sec.Close(wire.CodeNormal)
	out, err := mesh.AccountJoin(ctx, first.sec, id, name, raw)
	return out, first.m, err
}

// ErrNotApproved means the member still refuses this key (not approved yet, or denied).
var ErrNotApproved = errors.New("not approved yet")

// SyncApproved fetches the mesh from member with a kind 0x01 sync once a locked mesh admitted this
// node, applying the join checks (contract "Account join").
func SyncApproved(ctx context.Context, relays []string, id *ident.Identity, member login.OfferedMember, meshID string) (*mesh.Store, error) {
	noise, err := ident.DecodeKey(member.NoisePub)
	if err != nil {
		return nil, err
	}
	sec, err := OpenAny(ctx, relays, member.NodeID, func(conn relay.Conn) (*session.Secure, error) {
		return session.Initiate(ctx, conn, session.KindSession, member.NodeID, noise, id, nil, session.Payload{V: 1, Stream: "mesh"})
	})
	if relay.CodeOf(err) == wire.CodeNotAdmitted {
		return nil, ErrNotApproved
	}
	if err != nil {
		return nil, err
	}
	defer sec.Close(wire.CodeNormal)
	s := mesh.NewStore(nil, meshID)
	if err := mesh.SyncInitiate(ctx, sec, s, nil, nil); err != nil {
		if relay.CodeOf(err) == wire.CodeNotAdmitted {
			return nil, ErrNotApproved
		}
		return nil, err
	}
	return mesh.CheckJoined(nil, id, meshID, s.Records())
}

// SyncWith syncs s with every other member it lists (kind 0x01 mesh) and reports how many of the
// others took part (contract "Account join": a joiner syncs before it serves tcp streams).
func SyncWith(ctx context.Context, relays []string, id *ident.Identity, s *mesh.Store) (taken, others int) {
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, m := range s.View().SortedMembers() {
		if m.NodeID == id.NodeID() {
			continue
		}
		others++
		noise, err := ident.DecodeKey(m.NoisePub)
		if err != nil {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			pctx, cancel := context.WithTimeout(ctx, pushTimeout)
			defer cancel()
			sec, err := OpenAny(pctx, relays, m.NodeID, func(conn relay.Conn) (*session.Secure, error) {
				return session.Initiate(pctx, conn, session.KindSession, m.NodeID, noise, id, nil, session.Payload{V: 1, Stream: "mesh"})
			})
			if err != nil {
				return
			}
			defer sec.Close(wire.CodeNormal)
			if mesh.SyncInitiate(pctx, sec, s, nil, nil) == nil {
				mu.Lock()
				taken++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	return taken, others
}
