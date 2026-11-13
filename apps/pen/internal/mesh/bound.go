package mesh

import (
	"errors"
	"maps"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/strictjson"
)

// Subject is the one machine a bound invite admits: its card must carry exactly these keys and this name.
type Subject struct {
	SignPub  string `json:"signPub"`
	NoisePub string `json:"noisePub"`
	Name     string `json:"name"`
}

// UnmarshalJSON takes exactly the three members, so a misspelled one is refused instead of left empty.
func (s *Subject) UnmarshalJSON(b []byte) error {
	type plain Subject
	var p plain
	if err := strictjson.Unmarshal(b, &p); err != nil {
		return err
	}
	*s = Subject(p)
	return nil
}

// Valid checks that both keys are 32-byte keys in canonical base64url and that the name is a valid node name.
func (s Subject) Valid() error {
	for _, k := range []string{s.SignPub, s.NoisePub} {
		b, err := ident.DecodeKey(k)
		if err != nil || ident.B64.EncodeToString(b) != k {
			return errors.New("subject keys must be canonical base64url 32-byte keys")
		}
	}
	if !ident.ValidName(s.Name) {
		return errors.New("subject name is not a valid node name")
	}
	return nil
}

// admits reports whether a card carries the subject's keys, spelled exactly as the subject's canonical ones (card
// keys key the member map, so another spelling of the same key is another member), and its name. An invite without a
// subject admits any card.
func (s *Subject) admits(cb CardBody) bool {
	if s == nil {
		return true
	}
	return cb.SignPub == s.SignPub && cb.NoisePub == s.NoisePub && cb.Name == s.Name
}

// AdmitsNoise reports whether a joiner holding the Noise key noise may complete a handshake for the invite, so a
// machine other than the subject cannot hold a join session open with a bound invite's token.
func (s *Subject) AdmitsNoise(noise []byte) bool {
	return s == nil || s.NoisePub == ident.B64.EncodeToString(noise)
}

// ValidMintID reports whether m can name a mint: 1 to 64 ASCII letters, digits, '-', '_', '.' or ':'.
func ValidMintID(m string) bool {
	if len(m) < 1 || len(m) > 64 {
		return false
	}
	for _, c := range m {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.' || c == ':') {
			return false
		}
	}
	return true
}

// Refusals of CreateBound for its mintID: an earlier create used it, or a cancel fenced it.
var (
	ErrMintUsed      = errors.New("this mintId already made an invite")
	ErrMintCancelled = errors.New("this mintId was cancelled before its invite was made")
)

// CreateBound makes an invite that admits only sub, valid until expiresAt. A non-empty mintID names the request
// that makes it; under the book's lock, where clock is read, it is refused when an entry or a fence already carries
// that mintID or expiresAt has passed.
func (iv *Invites) CreateBound(sub Subject, mintID string, expiresAt time.Time, clock func() time.Time) (Invite, error) {
	return iv.CreateBoundNotify(sub, mintID, expiresAt, clock, nil)
}

// CreateBoundNotify is CreateBound that, when sig is not nil, attaches it to this invite in the same hold of the lock
// that makes the invite, so no cancel or burn can come before it.
func (iv *Invites) CreateBoundNotify(sub Subject, mintID string, expiresAt time.Time, clock func() time.Time, sig *Signals) (Invite, error) {
	if err := sub.Valid(); err != nil {
		return Invite{}, err
	}
	if mintID != "" && !ValidMintID(mintID) {
		return Invite{}, errors.New("mintId is not 1 to 64 letters, digits, '-', '_', '.' or ':'")
	}
	x, err := newInvite(expiresAt)
	if err != nil {
		return Invite{}, err
	}
	x.Subject, x.MintID = &sub, mintID
	iv.mu.Lock()
	defer iv.mu.Unlock()
	now := clock()
	if iv.retired {
		return Invite{}, errInviteRetired
	}
	if !expiresAt.After(now) {
		return Invite{}, errors.New("the invite would expire before it is made")
	}
	if mintID != "" {
		if prior, ok := iv.findLocked("", mintID); ok && prior.ID == "" {
			return Invite{}, ErrMintCancelled
		} else if ok {
			return Invite{}, ErrMintUsed
		}
	}
	if n := iv.boundLocked(); n >= maxBound || n+len(iv.fences) >= maxBoundAndFences {
		return Invite{}, errors.New("too many bound invites kept; acknowledge settled ones first")
	}
	byID := maps.Clone(iv.byID)
	byID[x.ID] = x
	if err := iv.commitLocked(now, byID, maps.Clone(iv.fences)); err != nil {
		return Invite{}, err
	}
	if sig != nil {
		iv.signals[x.ID] = sig
	}
	return x, nil
}
