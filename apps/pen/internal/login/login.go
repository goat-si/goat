// Package login speaks the Pen login service (contract "Accounts"): proofs, assertions, the device
// flow and the registry.
package login

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base32"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/strictjson"
)

// DefaultURL is the production login service.
const DefaultURL = "https://pen-login.pos090001.workers.dev"

const (
	startPrefix     = "pen-login/1 start"
	pollPrefix      = "pen-login/1 poll"
	forgetPrefix    = "pen-login/1 forget"
	assertionPrefix = "pen-login/1 assertion"
	// AssertionLifetime is exp - iat.
	AssertionLifetime = 600 * time.Second
	// Skew is the clock difference a member tolerates on iat and exp.
	Skew = 60 * time.Second
	// ForgetWindow is how far a forget's ts may be from the service's clock.
	ForgetWindow = 2 * time.Minute
	maxAssertion = 2048
	maxEmail     = 254
)

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// Kid is lowercase base32 of SHA-256(pub)[0..5]: 8 characters.
func Kid(pub []byte) string {
	sum := sha256.Sum256(pub)
	return strings.ToLower(b32.EncodeToString(sum[:5]))
}

// Key is a login key as the service lists it.
type Key struct {
	Kid string `json:"kid"`
	Pub string `json:"pub"`
}

// PubKey decodes the key and checks its kid.
func (k Key) PubKey() (ed25519.PublicKey, error) {
	pub, err := ident.DecodeKey(k.Pub)
	if err != nil {
		return nil, err
	}
	if Kid(pub) != k.Kid {
		return nil, errors.New("login: key id does not match the key")
	}
	return pub, nil
}

// StartMessage is what a device/start proof signs.
func StartMessage(signPub, noisePub []byte, name string) []byte {
	m := append([]byte(startPrefix), signPub...)
	m = append(m, noisePub...)
	return append(m, name...)
}

// PollMessage is what a device/token proof signs: the prefix and the device code's 32 raw bytes
// (deviceCode is their base64url form). A code that does not decode signs its text, which the
// service refuses.
func PollMessage(deviceCode string) []byte {
	raw, err := ident.B64.DecodeString(deviceCode)
	if err != nil {
		raw = []byte(deviceCode)
	}
	return append([]byte(pollPrefix), raw...)
}

// ForgetMessage is what a mesh/forget proof signs; ts is in milliseconds.
func ForgetMessage(nodeID string, ts uint64) []byte {
	m := append([]byte(forgetPrefix), nodeID...)
	return binary.BigEndian.AppendUint64(m, ts)
}

// AssertionBody is an assertion's signed content.
type AssertionBody struct {
	V        int    `json:"v"`
	Iss      string `json:"iss"`
	Kid      string `json:"kid"`
	Sub      string `json:"sub"`
	Email    string `json:"email"`
	SignPub  string `json:"signPub"`
	NoisePub string `json:"noisePub"`
	Iat      int64  `json:"iat"`
	Exp      int64  `json:"exp"`
}

// Assertion is the login service's statement that a node key belongs to a Google account.
type Assertion struct {
	Body []byte
	Sig  []byte
	A    AssertionBody
}

type signedJSON struct {
	Body string `json:"body"`
	Sig  string `json:"sig"`
}

func (a *Assertion) MarshalJSON() ([]byte, error) {
	return json.Marshal(signedJSON{Body: ident.B64.EncodeToString(a.Body), Sig: ident.B64.EncodeToString(a.Sig)})
}

// UnmarshalJSON decodes the wire form and parses the body; call Check before trusting it.
func (a *Assertion) UnmarshalJSON(b []byte) error {
	var s signedJSON
	if err := strictjson.Unmarshal(b, &s); err != nil {
		return fmt.Errorf("login: assertion: %w", err)
	}
	body, err1 := ident.B64.DecodeString(s.Body)
	sig, err2 := ident.B64.DecodeString(s.Sig)
	if err1 != nil || err2 != nil || len(sig) != ed25519.SignatureSize || len(body) > maxAssertion {
		return errors.New("login: assertion encoding")
	}
	var ab AssertionBody
	if err := strictjson.Unmarshal(body, &ab); err != nil {
		return fmt.Errorf("login: assertion body: %w", err)
	}
	a.Body, a.Sig, a.A = body, sig, ab
	return nil
}

// Hash is base64url SHA-256 of the body (what an admit's "assertion" names).
func (a *Assertion) Hash() string {
	sum := sha256.Sum256(a.Body)
	return ident.B64.EncodeToString(sum[:])
}

func assertionDigest(body []byte) []byte {
	sum := sha256.Sum256(body)
	return append([]byte(assertionPrefix), sum[:]...)
}

// Issue signs an assertion (the login service's side; the Go fake uses it).
func Issue(priv ed25519.PrivateKey, iss, sub, email string, signPub, noisePub []byte, now time.Time) (*Assertion, error) {
	ab := AssertionBody{V: 1, Iss: iss, Kid: Kid(priv.Public().(ed25519.PublicKey)), Sub: sub, Email: email,
		SignPub: ident.B64.EncodeToString(signPub), NoisePub: ident.B64.EncodeToString(noisePub),
		Iat: now.Unix(), Exp: now.Add(AssertionLifetime).Unix()}
	body, err := json.Marshal(ab)
	if err != nil {
		return nil, err
	}
	return &Assertion{Body: body, Sig: ed25519.Sign(priv, assertionDigest(body)), A: ab}, nil
}

// Binding is a mesh's account binding: which login service, key and Google account it trusts.
type Binding struct {
	LoginURL string
	Key      Key
	Sub      string
}

// ErrClockSkew marks a refusal for time, so a person can fix their clock.
var ErrClockSkew = errors.New("clock skew")

// Verify checks the signature under key and the body's form (the joining side's check of its own
// assertion and the registry's).
func (a *Assertion) Verify(key Key) error {
	pub, err := key.PubKey()
	if err != nil {
		return err
	}
	b := a.A
	if b.V != 1 || b.Kid != key.Kid {
		return errors.New("login: assertion is not signed by this login key")
	}
	if !ed25519.Verify(pub, assertionDigest(a.Body), a.Sig) {
		return errors.New("login: assertion signature")
	}
	if b.Sub == "" || len(b.Email) > maxEmail || b.Exp-b.Iat != int64(AssertionLifetime/time.Second) {
		return errors.New("login: assertion body")
	}
	if _, err := ident.DecodeKey(b.SignPub); err != nil {
		return err
	}
	if _, err := ident.DecodeKey(b.NoisePub); err != nil {
		return err
	}
	return nil
}

// Check is a member's full check against its mesh binding (contract "Account join"): the key id
// names the binding's key and the signature verifies, iss is the binding's login URL, sub is the
// binding's, and now is within [iat - 60 s, exp + 60 s).
func (a *Assertion) Check(b Binding, now time.Time) error {
	if err := a.Verify(b.Key); err != nil {
		return err
	}
	if a.A.Iss != b.LoginURL {
		return errors.New("login: assertion from another login service")
	}
	if a.A.Sub != b.Sub {
		return errors.New("login: assertion for another Google account")
	}
	if time.Unix(a.A.Iat, 0).After(now.Add(Skew)) {
		return fmt.Errorf("%w: the assertion was issued in the future; check this machine's clock", ErrClockSkew)
	}
	if !now.Before(time.Unix(a.A.Exp, 0).Add(Skew)) {
		return fmt.Errorf("%w or an expired sign-in: the assertion expired; sign in again or check the clocks", ErrClockSkew)
	}
	return nil
}

// ForKeys reports whether the assertion names exactly these node keys.
func (a *Assertion) ForKeys(signPub, noisePub []byte) bool {
	return a.A.SignPub == ident.B64.EncodeToString(signPub) && a.A.NoisePub == ident.B64.EncodeToString(noisePub)
}
