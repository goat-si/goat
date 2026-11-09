package mesh

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/session"
	"github.com/goat-si/goat/apps/pen/internal/state"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// TokenPrefix starts every invite token.
const TokenPrefix = "pen1_"

// Token is what an invite hands to a joiner: the inviter's keys, the invite secret and the relay.
type Token struct {
	SignPub  []byte
	NoisePub []byte
	Secret   []byte
	Relay    string
}

// String encodes pen1_ + base64url(version 1 || signPub || noisePub || secret || relay).
func (t Token) String() string {
	b := []byte{1}
	b = append(b, t.SignPub...)
	b = append(b, t.NoisePub...)
	b = append(b, t.Secret...)
	b = append(b, t.Relay...)
	return TokenPrefix + ident.B64.EncodeToString(b)
}

// ParseToken decodes an invite token.
func ParseToken(s string) (Token, error) {
	rest, ok := strings.CutPrefix(strings.TrimSpace(s), TokenPrefix)
	if !ok {
		return Token{}, errors.New("not a pen1_ invite token")
	}
	b, err := ident.B64.DecodeString(rest)
	if err != nil || len(b) < 1+96+1 || b[0] != 1 {
		return Token{}, errors.New("malformed invite token")
	}
	t := Token{SignPub: b[1:33], NoisePub: b[33:65], Secret: b[65:97], Relay: string(b[97:])}
	if _, err := wire.RelayOrigin(t.Relay); err != nil {
		return Token{}, fmt.Errorf("invite token relay: %w", err)
	}
	return t, nil
}

// NodeID is the inviter's nodeId.
func (t Token) NodeID() string { return ident.NodeID(t.SignPub) }

// Invite is a live single-use invite.
type Invite struct {
	ID        string `json:"id"`
	Secret    []byte `json:"secret"`
	ExpiresAt int64  `json:"expiresAt"`
}

// Invites are the node's live invites, persisted in offers.json.
type Invites struct {
	st   *state.Store
	mu   sync.Mutex
	live map[string]Invite
}

// LoadInvites reads offers.json (st may be nil for in-memory use).
func LoadInvites(st *state.Store) (*Invites, error) {
	iv := &Invites{st: st, live: map[string]Invite{}}
	if st == nil {
		return iv, nil
	}
	var list []Invite
	if _, err := st.ReadJSON("offers.json", &list); err != nil {
		return nil, err
	}
	for _, x := range list {
		iv.live[x.ID] = x
	}
	return iv, nil
}

func (iv *Invites) saveLocked(now time.Time) error {
	list := []Invite{}
	for id, x := range iv.live {
		if x.ExpiresAt <= now.UnixMilli() {
			delete(iv.live, id)
			continue
		}
		list = append(list, x)
	}
	if iv.st == nil {
		return nil
	}
	unlock, err := iv.st.Lock()
	if err != nil {
		return err
	}
	defer unlock()
	return iv.st.WriteJSON("offers.json", list, 0o600)
}

// Create makes an invite valid for ttl.
func (iv *Invites) Create(ttl time.Duration, now time.Time) (Invite, error) {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return Invite{}, err
	}
	x := Invite{ID: session.InviteID(secret), Secret: secret, ExpiresAt: now.Add(ttl).UnixMilli()}
	iv.mu.Lock()
	defer iv.mu.Unlock()
	iv.live[x.ID] = x
	return x, iv.saveLocked(now)
}

// Lookup finds a live (unexpired, unused) invite.
func (iv *Invites) Lookup(id string, now time.Time) (Invite, bool) {
	iv.mu.Lock()
	defer iv.mu.Unlock()
	x, ok := iv.live[id]
	if !ok || x.ExpiresAt <= now.UnixMilli() {
		return Invite{}, false
	}
	return x, true
}

// Burn atomically uses an invite; only one caller ever succeeds.
func (iv *Invites) Burn(id string, now time.Time) error {
	iv.mu.Lock()
	defer iv.mu.Unlock()
	x, ok := iv.live[id]
	if !ok || x.ExpiresAt <= now.UnixMilli() {
		return errors.New("invite already used or expired")
	}
	delete(iv.live, id)
	return iv.saveLocked(now)
}

// Admission is what an inviter needs to serve one join.
type Admission struct {
	ID       *ident.Identity
	Store    *Store
	Invites  *Invites
	InviteID string
	Now      func() time.Time
	// OnAdmit is called with the admit record after it is stored.
	OnAdmit func(admit *Record)
}

func refuse(c *Lines, reason string) error {
	c.Write(Msg{T: "refused", Reason: reason})
	c.L.Close(wire.CodeNotAdmitted)
	return fmt.Errorf("join refused: %s", reason)
}

// ServeJoin runs the inviter side after a confirmed kind 0x03 session from remoteStatic.
func ServeJoin(ctx context.Context, l Link, remoteStatic []byte, a Admission) (*Member, error) {
	c := &Lines{L: l}
	nonce, err := randomNonce()
	if err != nil {
		return nil, err
	}
	self := a.ID.NodeID()
	if err := c.Write(Msg{T: "offer", Mesh: a.Store.MeshID, Inviter: self, Nonce: nonce}); err != nil {
		return nil, err
	}
	m, err := c.Read(ctx)
	if err != nil {
		return nil, err
	}
	if m.T != "card" || m.Card == nil {
		return nil, refuse(c, "expected a card")
	}
	if err := m.Card.Verify(); err != nil {
		return nil, refuse(c, err.Error())
	}
	cb := m.Card.C
	if cb.Mesh != a.Store.MeshID || cb.Inviter != self || cb.Nonce != nonce {
		return nil, refuse(c, "card does not answer this offer")
	}
	if noise, _ := ident.DecodeKey(cb.NoisePub); !bytes.Equal(noise, remoteStatic) {
		return nil, refuse(c, "card noisePub is not the session key")
	}
	v := a.Store.View()
	if _, gone := v.Revoked[cb.SignPub]; gone {
		return nil, refuse(c, "this key was revoked")
	}
	for _, x := range v.Members {
		if x.SignPub == cb.SignPub || x.NoisePub == cb.NoisePub || x.NodeID == cb.NodeID {
			return nil, refuse(c, "already a member")
		}
	}
	now := a.Now()
	if err := a.Invites.Burn(a.InviteID, now); err != nil {
		l.Close(wire.CodeNotAdmitted)
		return nil, &relay.CloseError{Code: wire.CodeNotAdmitted}
	}
	admit, err := a.Store.Append(a.ID, TypeAdmit, now.UnixMilli(), Fields{Card: m.Card})
	if err != nil {
		return nil, refuse(c, "could not sign the admit")
	}
	member, ok := a.Store.View().Members[cb.SignPub]
	if !ok {
		return nil, refuse(c, "admit had no effect")
	}
	if a.OnAdmit != nil {
		a.OnAdmit(admit)
	}
	if err := c.writeRecords(a.Store.Records()); err != nil {
		return nil, err
	}
	if err := c.Write(Msg{T: "done", Mesh: a.Store.MeshID}); err != nil {
		return nil, err
	}
	return &member, nil
}

// RefusedError is the inviter's refusal.
type RefusedError struct{ Reason string }

func (e *RefusedError) Error() string { return "join refused: " + e.Reason }

// Join runs the joiner side after a confirmed kind 0x03 session. It returns the mesh id and set.
func Join(ctx context.Context, l Link, id *ident.Identity, name string) (string, []*Record, error) {
	c := &Lines{L: l}
	m, err := c.Read(ctx)
	if err != nil {
		return "", nil, err
	}
	if m.T == "refused" {
		return "", nil, &RefusedError{Reason: m.Reason}
	}
	if m.T != "offer" || m.Mesh == "" || !ident.ValidNodeID(m.Inviter) {
		l.Close(wire.CodeCrypto)
		return "", nil, errors.New("join: expected an offer")
	}
	card, err := MakeCard(id, m.Mesh, m.Inviter, m.Nonce, name)
	if err != nil {
		return "", nil, err
	}
	if err := c.Write(Msg{T: "card", Card: card}); err != nil {
		return "", nil, err
	}
	meshID := m.Mesh
	var recs []*Record
	for {
		m, err := c.Read(ctx)
		if err != nil {
			return "", nil, err
		}
		switch m.T {
		case "refused":
			return "", nil, &RefusedError{Reason: m.Reason}
		case "records":
			recs = append(recs, m.Records...)
			if len(recs) > MaxRecords {
				l.Close(wire.CodeCrypto)
				return "", nil, errors.New("join: more than 4096 records")
			}
		case "done":
			if m.Mesh != meshID {
				l.Close(wire.CodeCrypto)
				return "", nil, errors.New("join: done names another mesh")
			}
			return meshID, recs, nil
		}
	}
}

// CheckJoined verifies a joined set: its founding record matches meshID and the view has id.
func CheckJoined(st *state.Store, id *ident.Identity, meshID string, recs []*Record) (*Store, error) {
	s, err := FromJoin(st, meshID, recs)
	if err != nil {
		return nil, err
	}
	if _, ok := s.View().Members[ident.B64.EncodeToString(id.SignPub)]; !ok {
		return nil, errors.New("join: the mesh view does not make this node a member")
	}
	return s, nil
}

