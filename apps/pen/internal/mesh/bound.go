package mesh

import (
	"bytes"
	"encoding/json"
	"errors"
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

// admits reports whether a card carries the subject's keys and name; an invite without a subject admits any card.
func (s *Subject) admits(cb CardBody) bool {
	if s == nil {
		return true
	}
	return sameKey(cb.SignPub, s.SignPub) && sameKey(cb.NoisePub, s.NoisePub) && cb.Name == s.Name
}

func sameKey(a, b string) bool {
	x, err1 := ident.DecodeKey(a)
	y, err2 := ident.DecodeKey(b)
	return err1 == nil && err2 == nil && bytes.Equal(x, y)
}

// CreateBound makes an invite that admits only sub, valid until expiresAt.
func (iv *Invites) CreateBound(sub Subject, expiresAt, now time.Time) (Invite, error) {
	if err := sub.Valid(); err != nil {
		return Invite{}, err
	}
	if !expiresAt.After(now) {
		return Invite{}, errors.New("the invite would expire before it is made")
	}
	return iv.create(expiresAt, now, &sub)
}

// subjectJSON is the subject as offers.json stores it (tests read it back).
func subjectJSON(s *Subject) string {
	b, _ := json.Marshal(s)
	return string(b)
}
