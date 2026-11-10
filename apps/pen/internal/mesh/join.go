package mesh

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net"
	"net/url"
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

// Token is what an invite hands to a joiner: the inviter's keys, the invite secret and its relays.
type Token struct {
	SignPub  []byte
	NoisePub []byte
	Secret   []byte
	Relays   []string
}

// Token v2 limits.
const (
	MaxTokenRelays   = 8
	MaxTokenRelayLen = 256
)

// String encodes pen1_ + base64url(version || signPub || noisePub || secret || relays). One relay
// is version 1 (older nodes can join); several are version 2, joined by LF.
func (t Token) String() string {
	version := byte(1)
	if len(t.Relays) > 1 {
		version = 2
	}
	b := []byte{version}
	b = append(b, t.SignPub...)
	b = append(b, t.NoisePub...)
	b = append(b, t.Secret...)
	b = append(b, strings.Join(t.Relays, string(rune(10)))...)
	return TokenPrefix + ident.B64.EncodeToString(b)
}

// ParseToken decodes a version 1 or 2 invite token.
func ParseToken(s string) (Token, error) {
	rest, ok := strings.CutPrefix(strings.TrimSpace(s), TokenPrefix)
	if !ok {
		return Token{}, errors.New("not a pen1_ invite token")
	}
	b, err := ident.B64.DecodeString(rest)
	if err != nil || len(b) < 1+96+1 || b[0] != 1 && b[0] != 2 {
		return Token{}, errors.New("malformed invite token")
	}
	t := Token{SignPub: b[1:33], NoisePub: b[33:65], Secret: b[65:97]}
	if b[0] == 1 {
		t.Relays = []string{string(b[97:])}
		if err := relayScheme(t.Relays[0]); err != nil {
			return Token{}, fmt.Errorf("invite token relay: %w", err)
		}
		if _, err := wire.RelayOrigin(t.Relays[0]); err != nil {
			return Token{}, fmt.Errorf("invite token relay: %w", err)
		}
		return t, nil
	}
	t.Relays = strings.Split(string(b[97:]), string(rune(10)))
	if err := ValidRelayList(t.Relays); err != nil {
		return Token{}, fmt.Errorf("invite token relays: %w", err)
	}
	return t, nil
}

// ValidRelayList checks a version 2 relay list: 1 to 8 URLs of at most 256 bytes naming distinct
// relay origins, https or wss (http or ws only for loopback hosts, for local relays).
func ValidRelayList(relays []string) error {
	if len(relays) < 1 || len(relays) > MaxTokenRelays {
		return fmt.Errorf("%d relays (1 to %d)", len(relays), MaxTokenRelays)
	}
	seen := map[string]bool{}
	for _, r := range relays {
		if r == "" || len(r) > MaxTokenRelayLen {
			return fmt.Errorf("relay URL empty or over %d bytes", MaxTokenRelayLen)
		}
		if err := relayScheme(r); err != nil {
			return err
		}
		origin, err := wire.RelayOrigin(r)
		if err != nil {
			return err
		}
		// One relay under two spellings (case, default port, https vs wss) is a duplicate.
		if seen[origin] {
			return fmt.Errorf("duplicate relay %q", r)
		}
		seen[origin] = true
	}
	return nil
}

// relayScheme refuses a relay URL that is not https or wss, allowing http or ws only to a loopback
// host, so neither token version can point a joiner at a plain-text relay on the network.
func relayScheme(r string) error {
	u, err := url.Parse(r)
	if err != nil {
		return err
	}
	switch strings.ToLower(u.Scheme) {
	case "https", "wss":
	case "http", "ws":
		if !loopback(u.Hostname()) {
			return fmt.Errorf("relay %q: plain http only for loopback hosts", r)
		}
	default:
		return fmt.Errorf("relay %q: scheme must be https or wss", r)
	}
	return nil
}

func loopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
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
	// retired is set when the node's mesh is replaced: this book no longer writes offers.json.
	retired bool
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
	if iv.st == nil || iv.retired {
		return nil
	}
	unlock, err := iv.st.Lock()
	if err != nil {
		return err
	}
	defer unlock()
	return iv.st.WriteJSON("offers.json", list, 0o600)
}

// Retire stops this book from writing offers.json; a save already running finishes first.
func (iv *Invites) Retire() {
	iv.mu.Lock()
	iv.retired = true
	iv.mu.Unlock()
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
	if iv.retired {
		return Invite{}, errors.New("this node's mesh changed while the invite was made; run pen invite again")
	}
	iv.live[x.ID] = x
	return x, iv.saveLocked(now)
}

// Prune drops expired invites from memory and offers.json.
func (iv *Invites) Prune(now time.Time) error {
	iv.mu.Lock()
	defer iv.mu.Unlock()
	for _, x := range iv.live {
		if x.ExpiresAt <= now.UnixMilli() {
			return iv.saveLocked(now)
		}
	}
	return nil
}

// Lookup finds a live (unexpired, unused) invite.
func (iv *Invites) Lookup(id string, now time.Time) (Invite, bool) {
	iv.mu.Lock()
	defer iv.mu.Unlock()
	x, ok := iv.live[id]
	if !ok {
		return Invite{}, false
	}
	if x.ExpiresAt <= now.UnixMilli() {
		// The join is refused either way; a failed write leaves the secret for the next save.
		_ = iv.saveLocked(now)
		return Invite{}, false
	}
	return x, true
}

// Burn atomically uses an invite; only one caller ever succeeds.
func (iv *Invites) Burn(id string, now time.Time) error {
	iv.mu.Lock()
	defer iv.mu.Unlock()
	x, ok := iv.live[id]
	if !ok {
		return errors.New("invite already used or expired")
	}
	if x.ExpiresAt <= now.UnixMilli() {
		if err := iv.saveLocked(now); err != nil {
			return err
		}
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

// NotMemberReason is the reason a node that is not a member of its mesh refuses an admission.
const NotMemberReason = "this machine is not a member of the mesh"

// IsMember reports whether id's key is a current member in s's view. Every admitting path checks
// it at its point of no return: an admit signed by a key that is not a member has no effect.
func IsMember(s *Store, id *ident.Identity) bool {
	_, ok := s.View().Members[ident.B64.EncodeToString(id.SignPub)]
	return ok
}

func refuseNotMember(c *Lines) error {
	c.Write(Msg{T: "refused", Reason: NotMemberReason, NotMember: true})
	c.L.Close(wire.CodeNotAdmitted)
	return &RefusedError{Reason: NotMemberReason, NotMember: true}
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
	// The membership check, the burn and the signature hold the store's lock together: an
	// inviter that is no longer a member keeps the invite unused.
	errBurn := errors.New("burn")
	admit, err := a.Store.AppendAsMember(a.ID, TypeAdmit, now.UnixMilli(), Fields{Card: m.Card}, func() error {
		if err := a.Invites.Burn(a.InviteID, now); err != nil {
			return errBurn
		}
		return nil
	})
	switch {
	case errors.Is(err, ErrNotMember):
		return nil, refuseNotMember(c)
	case errors.Is(err, errBurn):
		l.Close(wire.CodeNotAdmitted)
		return nil, &relay.CloseError{Code: wire.CodeNotAdmitted}
	case err != nil:
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

// RefusedError is the inviter's refusal; NotMember says the inviter is not a member of its mesh.
type RefusedError struct {
	Reason    string
	NotMember bool
}

func (e *RefusedError) Error() string { return "join refused: " + e.Reason }

// Join runs the joiner side after a confirmed kind 0x03 session. It returns the mesh id and set.
func Join(ctx context.Context, l Link, id *ident.Identity, name string) (string, []*Record, error) {
	c := &Lines{L: l}
	m, err := c.Read(ctx)
	if err != nil {
		return "", nil, err
	}
	if m.T == "refused" {
		return "", nil, &RefusedError{Reason: m.Reason, NotMember: m.NotMember}
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
			return "", nil, &RefusedError{Reason: m.Reason, NotMember: m.NotMember}
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
	s.SetSelf(ident.B64.EncodeToString(id.SignPub))
	if _, ok := s.View().Members[ident.B64.EncodeToString(id.SignPub)]; !ok {
		return nil, errors.New("join: the mesh view does not make this node a member")
	}
	return s, nil
}
