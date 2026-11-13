package mesh

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"maps"
	"sync"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/session"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

// Invite is an entry of offers.json: a live single-use invite, or the terminal state a bound invite reached. Its file
// form is inviteFile.
type Invite struct {
	ID        string
	Secret    []byte
	ExpiresAt int64
	// Subject, when set, is the only machine the invite admits (a bound invite).
	Subject *Subject
	// MintID is the caller's name for the request that made a bound invite, or for a cancel that came first.
	MintID string
	// State is empty for a live invite, else burned, cancelled or expired. A terminal entry keeps no secret and no
	// expiry.
	State string
	// Nonce is a burned invite's offer nonce, which the admitted card repeats; At is when it reached State.
	Nonce string
	At    int64
}

// inviteFile is an Invite as offers.json stores it. An ordinary invite has exactly dev's members (id, secret,
// expiresAt). A bound one keeps its secret and expiry under boundSecret and boundExpiresAt, which a node older than
// bound invites does not read: after a downgrade it sees no secret and no expiry, takes the entry for expired and
// prunes it instead of admitting any machine with it.
type inviteFile struct {
	ID             string   `json:"id,omitempty"`
	Secret         []byte   `json:"secret,omitempty"`
	ExpiresAt      int64    `json:"expiresAt,omitempty"`
	Subject        *Subject `json:"subject,omitempty"`
	MintID         string   `json:"mintId,omitempty"`
	BoundSecret    []byte   `json:"boundSecret,omitempty"`
	BoundExpiresAt int64    `json:"boundExpiresAt,omitempty"`
	State          string   `json:"state,omitempty"`
	Nonce          string   `json:"nonce,omitempty"`
	At             int64    `json:"at,omitempty"`
}

// MarshalJSON writes the file form.
func (x Invite) MarshalJSON() ([]byte, error) {
	f := inviteFile{ID: x.ID, Secret: x.Secret, ExpiresAt: x.ExpiresAt, Subject: x.Subject, MintID: x.MintID, State: x.State,
		Nonce: x.Nonce, At: x.At}
	if x.Subject != nil {
		f.Secret, f.ExpiresAt, f.BoundSecret, f.BoundExpiresAt = nil, 0, x.Secret, x.ExpiresAt
	}
	return json.Marshal(f)
}

// UnmarshalJSON reads the file form.
func (x *Invite) UnmarshalJSON(b []byte) error {
	var f inviteFile
	if err := json.Unmarshal(b, &f); err != nil {
		return err
	}
	*x = f.invite()
	return nil
}

func (f inviteFile) invite() Invite {
	x := Invite{ID: f.ID, Secret: f.Secret, ExpiresAt: f.ExpiresAt, Subject: f.Subject, MintID: f.MintID, State: f.State,
		Nonce: f.Nonce, At: f.At}
	if f.Subject != nil && !f.earlierForm() {
		x.Secret, x.ExpiresAt = f.BoundSecret, f.BoundExpiresAt
	}
	return x
}

// earlierForm reports a bound entry written before its secret moved to boundSecret (#3117): it keeps secret and
// expiresAt, which a node older than bound invites would read and use.
func (f inviteFile) earlierForm() bool {
	return f.Subject != nil && f.BoundSecret == nil && f.BoundExpiresAt == 0 && (f.Secret != nil || f.ExpiresAt != 0)
}

// Invite states as cancel answers them.
const (
	InviteLive      = "live"
	InviteBurned    = "burned"
	InviteCancelled = "cancelled"
	InviteExpired   = "expired"
	InviteAbsent    = "absent"
)

// Caps on bound entries: a create is refused at maxBound, a fence at maxBoundAndFences, so a caller that never
// acknowledges cannot grow offers.json without bound.
const (
	maxBound          = 256
	maxBoundAndFences = 512
)

// Invites are the node's invites, persisted in offers.json.
type Invites struct {
	st *state.Store
	mu sync.Mutex
	// byID holds live invites and bound terminal entries; fences holds cancels by mintId that no invite answered.
	byID   map[string]Invite
	fences map[string]Invite
	// signals holds, in memory only, what a live invite's maker waits on: closed when that invite is cancelled or
	// burned, dropped when it ends otherwise. Attached and closed under mu with the invite itself.
	signals map[string]*Signals
	// retired is set when the node's mesh is replaced: this book no longer writes offers.json.
	retired bool
	// rewrite is set while offers.json still holds a bound entry in the earlier file form; Prune saves until it is
	// written.
	rewrite bool
}

// LoadInvites reads offers.json (st may be nil for in-memory use).
func LoadInvites(st *state.Store) (*Invites, error) {
	iv := &Invites{st: st, byID: map[string]Invite{}, fences: map[string]Invite{}, signals: map[string]*Signals{}}
	if st == nil {
		return iv, nil
	}
	var list []inviteFile
	if _, err := st.ReadJSON("offers.json", &list); err != nil {
		return nil, err
	}
	for _, f := range list {
		iv.rewrite = iv.rewrite || f.earlierForm()
		x := f.invite()
		switch {
		case x.ID != "":
			iv.byID[x.ID] = x
		case x.MintID != "" && x.State == InviteCancelled:
			iv.fences[x.MintID] = x
		}
	}
	if iv.rewrite {
		// Moved to the current form at once, so a node downgraded before any later save finds no secret to use. A
		// failed write keeps the book as read and is retried by every prune until it succeeds. At time zero no
		// invite with a real (positive) expiry is settled: this write only changes the form.
		_ = iv.saveLocked(time.UnixMilli(0))
	}
	return iv, nil
}

func expired(x Invite, now time.Time) bool { return x.State == "" && x.ExpiresAt <= now.UnixMilli() }

// commitLocked settles expired live invites in byID (an ordinary one is dropped, a bound one becomes an expired entry),
// writes byID and fences, and makes them the book. A failed write leaves the book as it was; an ordinary invite's
// burn changes the book before, as it always did.
func (iv *Invites) commitLocked(now time.Time, byID, fences map[string]Invite) error {
	list := []Invite{}
	for id, x := range byID {
		if expired(x, now) {
			if x.Subject == nil {
				delete(byID, id)
				continue
			}
			x = terminal(x, InviteExpired, time.UnixMilli(x.ExpiresAt), "")
			byID[id] = x
		}
		list = append(list, x)
	}
	for _, x := range fences {
		list = append(list, x)
	}
	if iv.st != nil && !iv.retired {
		unlock, err := iv.st.Lock()
		if err != nil {
			return err
		}
		defer unlock()
		if err := iv.st.WriteJSON("offers.json", list, 0o600); err != nil {
			return err
		}
		iv.rewrite = false
	}
	iv.byID, iv.fences = byID, fences
	for id := range iv.signals {
		if x, ok := byID[id]; !ok || x.State != "" {
			delete(iv.signals, id)
		}
	}
	return nil
}

// saveLocked writes the book as it is.
func (iv *Invites) saveLocked(now time.Time) error {
	return iv.commitLocked(now, maps.Clone(iv.byID), maps.Clone(iv.fences))
}

// Retire stops this book from writing offers.json; a save already running finishes first.
func (iv *Invites) Retire() {
	iv.mu.Lock()
	iv.retired = true
	iv.mu.Unlock()
}

// Create makes an invite valid for ttl.
func (iv *Invites) Create(ttl time.Duration, now time.Time) (Invite, error) {
	return iv.CreateNotify(ttl, now, nil)
}

// Signals are the channels an invite's maker waits on, each closed once in the same hold of the book's lock that
// commits the event: Cancelled when invite.cancel ends the invite, Burned when a join uses it.
type Signals struct {
	Cancelled, Burned chan struct{}
}

// WaitExpiry decides, under the book's lock and by clock, what a wait on invite id answers when its timer fires. The
// timer runs on the monotonic clock and the invite expires by the node's clock, so: burned when a join used the
// invite (a burn checks, saves and closes Burned in one hold of this lock, so one in progress is waited for);
// cancelled; live with the time left while clock has not reached the expiry; otherwise expired, after the expiry is
// written, so no burn can come after the answer. A failed write is returned, and the wait must not answer expired.
func (iv *Invites) WaitExpiry(id string, sig *Signals, clock func() time.Time) (state string, left time.Duration, err error) {
	iv.mu.Lock()
	defer iv.mu.Unlock()
	select {
	case <-sig.Burned:
		return InviteBurned, 0, nil
	case <-sig.Cancelled:
		return InviteCancelled, 0, nil
	default:
	}
	now := clock()
	x, ok := iv.byID[id]
	switch {
	case !ok:
		// Neither burned nor cancelled: an ordinary invite pruned at its expiry, or dropped by a burn whose save
		// failed. The book is written first, so offers.json no longer holds it either.
		if err := iv.saveLocked(now); err != nil {
			return "", 0, err
		}
		return InviteExpired, 0, nil
	case x.State != "":
		return x.State, 0, nil
	case !expired(x, now):
		return InviteLive, time.UnixMilli(x.ExpiresAt).Sub(now), nil
	}
	if err := iv.saveLocked(now); err != nil {
		return "", 0, err
	}
	return InviteExpired, 0, nil
}

// NewSignals makes a fresh pair.
func NewSignals() *Signals {
	return &Signals{Cancelled: make(chan struct{}), Burned: make(chan struct{})}
}

// CreateNotify is Create that, when sig is not nil, attaches it to this invite.
func (iv *Invites) CreateNotify(ttl time.Duration, now time.Time, sig *Signals) (Invite, error) {
	x, err := newInvite(now.Add(ttl))
	if err != nil {
		return Invite{}, err
	}
	iv.mu.Lock()
	defer iv.mu.Unlock()
	if iv.retired {
		return Invite{}, errInviteRetired
	}
	iv.byID[x.ID] = x
	if sig != nil {
		iv.signals[x.ID] = sig
	}
	return x, iv.saveLocked(now)
}

var errInviteRetired = errors.New("this node's mesh changed while the invite was made; run pen invite again")

func newInvite(expiresAt time.Time) (Invite, error) {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return Invite{}, err
	}
	return Invite{ID: session.InviteID(secret), Secret: secret, ExpiresAt: expiresAt.UnixMilli()}, nil
}

// Prune drops expired ordinary invites from memory and offers.json and keeps expired bound ones as expired entries.
func (iv *Invites) Prune(now time.Time) error {
	iv.mu.Lock()
	defer iv.mu.Unlock()
	if iv.rewrite {
		return iv.saveLocked(now)
	}
	for _, x := range iv.byID {
		if expired(x, now) {
			return iv.saveLocked(now)
		}
	}
	return nil
}

// Lookup finds a live (unexpired, unused) invite.
func (iv *Invites) Lookup(id string, now time.Time) (Invite, bool) {
	iv.mu.Lock()
	defer iv.mu.Unlock()
	x, ok := iv.byID[id]
	if !ok || x.State != "" {
		return Invite{}, false
	}
	if expired(x, now) {
		// The join is refused either way; a failed write leaves the secret for the next save.
		_ = iv.saveLocked(now)
		return Invite{}, false
	}
	return x, true
}

// Burn atomically uses an invite for the joiner whose card is cb; only one caller ever succeeds, and a bound
// invite only for its subject. A bound invite becomes a burned entry carrying the offer nonce, in the same save.
// An ordinary invite is judged at now, when the join began, as it always was; a bound one reads clock under the
// book's lock, so a bound invite that expired while the join waited for it is not burned.
func (iv *Invites) Burn(id string, now time.Time, cb CardBody, clock func() time.Time) error {
	iv.mu.Lock()
	defer iv.mu.Unlock()
	x, ok := iv.byID[id]
	if !ok || x.State != "" {
		return errors.New("invite already used or expired")
	}
	if x.Subject != nil {
		now = clock()
	}
	if expired(x, now) {
		if err := iv.saveLocked(now); err != nil {
			return err
		}
		return errors.New("invite already used or expired")
	}
	if !x.Subject.admits(cb) {
		return errors.New("card does not match this invite")
	}
	sig := iv.signals[id]
	var err error
	if x.Subject == nil {
		delete(iv.byID, id)
		err = iv.saveLocked(now)
	} else {
		byID := maps.Clone(iv.byID)
		byID[id] = terminal(x, InviteBurned, now, cb.Nonce)
		err = iv.commitLocked(now, byID, maps.Clone(iv.fences))
	}
	if err == nil && sig != nil {
		close(sig.Burned)
	}
	return err
}

func terminal(x Invite, state string, now time.Time, nonce string) Invite {
	return Invite{ID: x.ID, Subject: x.Subject, MintID: x.MintID, State: state, Nonce: nonce, At: now.UnixMilli()}
}

// Cancel ends the invite named by id, or the one mintID made (exactly one is set), so it admits nobody, and
// answers the state it is in: cancelled (by this call or an earlier one), burned, expired or absent. A mintID that
// names nothing yet is fenced: it answers cancelled and a later create with that mintID is refused. clock is read
// under the book's lock.
func (iv *Invites) Cancel(id, mintID string, clock func() time.Time) (string, error) {
	iv.mu.Lock()
	defer iv.mu.Unlock()
	now := clock()
	x, ok := iv.findLocked(id, mintID)
	byID, fences := maps.Clone(iv.byID), maps.Clone(iv.fences)
	switch {
	case !ok && mintID == "":
		return InviteAbsent, nil
	case !ok:
		if len(iv.fences)+iv.boundLocked() >= maxBoundAndFences {
			return "", errors.New("too many bound invites and cancels kept; acknowledge settled ones first")
		}
		fences[mintID] = Invite{MintID: mintID, State: InviteCancelled, At: now.UnixMilli()}
	case x.State != "":
		return x.State, nil
	case expired(x, now):
		return InviteExpired, iv.saveLocked(now)
	case x.Subject == nil:
		delete(byID, x.ID)
	default:
		byID[x.ID] = terminal(x, InviteCancelled, now, "")
	}
	sig := iv.signals[x.ID]
	if err := iv.commitLocked(now, byID, fences); err != nil {
		return "", err
	}
	if sig != nil {
		close(sig.Cancelled)
	}
	return InviteCancelled, nil
}

// findLocked finds the entry named by id, or by mintID among the invites and then the fences.
func (iv *Invites) findLocked(id, mintID string) (Invite, bool) {
	if id != "" {
		x, ok := iv.byID[id]
		return x, ok
	}
	if mintID == "" {
		return Invite{}, false
	}
	for _, x := range iv.byID {
		if x.MintID == mintID {
			return x, true
		}
	}
	x, ok := iv.fences[mintID]
	return x, ok
}

func (iv *Invites) boundLocked() int {
	n := 0
	for _, x := range iv.byID {
		if x.Subject != nil {
			n++
		}
	}
	return n
}

// Ack forgets the terminal entry or fence named by id or mintID once its caller has read it, and answers acked, or
// absent when there is none. A live invite is refused: cancel it first. clock is read under the book's lock.
func (iv *Invites) Ack(id, mintID string, clock func() time.Time) (string, error) {
	iv.mu.Lock()
	defer iv.mu.Unlock()
	now := clock()
	x, ok := iv.findLocked(id, mintID)
	if !ok {
		return InviteAbsent, nil
	}
	if x.State == "" && !expired(x, now) {
		return "", errors.New("the invite is live; cancel it first")
	}
	byID, fences := maps.Clone(iv.byID), maps.Clone(iv.fences)
	if x.ID == "" {
		delete(fences, x.MintID)
	} else {
		delete(byID, x.ID)
	}
	if err := iv.commitLocked(now, byID, fences); err != nil {
		return "", err
	}
	return "acked", nil
}
