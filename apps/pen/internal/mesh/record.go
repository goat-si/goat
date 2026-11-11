// Package mesh holds the signed record log a mesh agrees on, the view replayed from it, sync and join.
package mesh

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/login"
	"github.com/goat-si/goat/apps/pen/internal/strictjson"
)

// Record types.
const (
	TypeFound    = "found"
	TypeAdmit    = "admit"
	TypeRevoke   = "revoke"
	TypeName     = "name"
	TypeHostKeys = "hostkeys"
	TypeAccount  = "account"
	TypeLock     = "lock"
)

// ViaGoogle marks an admit made for a Google account assertion.
const ViaGoogle = "google"

const (
	recordPrefix   = "pen-mesh/1"
	cardPrefix     = "pen-mesh/1 card"
	maxBody        = 2048
	maxPrev        = 64
	maxSubjects    = 16
	maxHostKeys    = 8
	foundMesh      = "-"
	hashLen        = 43
	nonceBytes     = 16
	maxHostKeyLine = 1024
	maxEmail       = 254
	maxLoginURL    = 256
	maxSub         = 255
	// maxAccountAdmitPrev is how many heads an admit via google names.
	maxAccountAdmitPrev = 8
	// maxSharedPrev is how many heads a record of a shared mesh names (ADR-0026).
	maxSharedPrev = 8
	// maxOwnCards is how many of its found and admit records a first record of a shared mesh names.
	maxOwnCards = 4
)

// Card is a member card signed by its subject.
type Card struct {
	Body []byte
	Sig  []byte
	C    CardBody
}

// CardBody is a card's signed content.
type CardBody struct {
	V        int    `json:"v"`
	Mesh     string `json:"mesh"`
	Inviter  string `json:"inviter"`
	Nonce    string `json:"nonce"`
	NodeID   string `json:"nodeId"`
	SignPub  string `json:"signPub"`
	NoisePub string `json:"noisePub"`
	Name     string `json:"name"`
}

type signedJSON struct {
	Body string `json:"body"`
	Sig  string `json:"sig"`
}

func (c *Card) MarshalJSON() ([]byte, error) {
	return json.Marshal(signedJSON{Body: ident.B64.EncodeToString(c.Body), Sig: ident.B64.EncodeToString(c.Sig)})
}

func (c *Card) UnmarshalJSON(b []byte) error {
	body, sig, err := decodeSigned(b, strictjson.UnmarshalNested)
	if err != nil {
		return err
	}
	c.Body, c.Sig = body, sig
	return nil
}

func decodeSigned(b []byte, decode func([]byte, any) error) ([]byte, []byte, error) {
	var s signedJSON
	if err := decode(b, &s); err != nil {
		return nil, nil, err
	}
	body, err1 := ident.B64.DecodeString(s.Body)
	sig, err2 := ident.B64.DecodeString(s.Sig)
	if err1 != nil || err2 != nil || len(sig) != ed25519.SignatureSize {
		return nil, nil, errors.New("mesh: bad body or sig encoding")
	}
	return body, sig, nil
}

func digest(prefix string, body []byte) []byte {
	sum := sha256.Sum256(body)
	return append([]byte(prefix), sum[:]...)
}

// MakeCard signs a card for id.
func MakeCard(id *ident.Identity, mesh, inviter, nonce, name string) (*Card, error) {
	cb := CardBody{V: 1, Mesh: mesh, Inviter: inviter, Nonce: nonce, NodeID: id.NodeID(),
		SignPub: ident.B64.EncodeToString(id.SignPub), NoisePub: ident.B64.EncodeToString(id.NoisePub), Name: name}
	body, err := json.Marshal(cb)
	if err != nil {
		return nil, err
	}
	c := &Card{Body: body, Sig: ed25519.Sign(id.SignPriv, digest(cardPrefix, body))}
	return c, c.Verify()
}

// Verify parses and checks the card's body and signature.
func (c *Card) Verify() error {
	if len(c.Body) > maxBody {
		return errors.New("mesh: card body too large")
	}
	var cb CardBody
	if err := strictjson.UnmarshalNested(c.Body, &cb); err != nil {
		return fmt.Errorf("mesh: card: %w", err)
	}
	if cb.V != 1 {
		return errors.New("mesh: card v")
	}
	signPub, err := ident.DecodeKey(cb.SignPub)
	if err != nil {
		return err
	}
	if _, err := ident.DecodeKey(cb.NoisePub); err != nil {
		return err
	}
	if nonce, err := ident.B64.DecodeString(cb.Nonce); err != nil || len(nonce) != nonceBytes {
		return errors.New("mesh: card nonce")
	}
	if cb.NodeID != ident.NodeID(signPub) {
		return errors.New("mesh: card nodeId does not match signPub")
	}
	if !ident.ValidName(cb.Name) {
		return errors.New("mesh: card name")
	}
	if !ed25519.Verify(signPub, digest(cardPrefix, c.Body), c.Sig) {
		return errors.New("mesh: card signature")
	}
	c.C = cb
	return nil
}

// Body is a record's signed content.
type Body struct {
	V           int      `json:"v"`
	Mesh        string   `json:"mesh"`
	Type        string   `json:"type"`
	By          string   `json:"by"`
	N           uint64   `json:"n"`
	Prev        []string `json:"prev"`
	At          int64    `json:"at"`
	Card        *Card    `json:"card,omitempty"`
	Subjects    []string `json:"subjects,omitempty"`
	Compromised *bool    `json:"compromised,omitempty"`
	Subject     string   `json:"subject,omitempty"`
	Name        string   `json:"name,omitempty"`
	Keys        []string `json:"keys,omitempty"`
	User        *string  `json:"user,omitempty"`
	// account: LoginURL, LoginKey and Sub (a string, or JSON null to unbind).
	LoginURL *string         `json:"loginUrl,omitempty"`
	LoginKey *LoginKey       `json:"loginKey,omitempty"`
	Sub      json.RawMessage `json:"sub,omitempty"`
	// lock
	On *bool `json:"on,omitempty"`
	// admit for a Google account: Via "google", the account's email and the assertion's hash.
	Via       *string `json:"via,omitempty"`
	Email     *string `json:"email,omitempty"`
	Assertion *string `json:"assertion,omitempty"`
}

// LoginKey is a login service key an account record trusts.
type LoginKey struct {
	Kid string `json:"kid"`
	Pub string `json:"pub"`
}

func (k *LoginKey) UnmarshalJSON(b []byte) error {
	type plain LoginKey
	var p plain
	if err := strictjson.UnmarshalNested(b, &p); err != nil {
		return err
	}
	*k = LoginKey(p)
	return nil
}

// Account is a mesh's binding to one Google account at one login service.
type Account struct {
	LoginURL string   `json:"loginUrl"`
	LoginKey LoginKey `json:"loginKey"`
	Sub      string   `json:"sub"`
}

// Record is a signed mesh record. Body holds the exact signed bytes.
type Record struct {
	Body []byte
	Sig  []byte
	B    Body
	Hash string
	// Sum is the raw SHA-256 of Body; canonical order compares it as unsigned bytes.
	Sum [32]byte
	// Opaque marks a record of an unknown type or with unknown members: stored and forwarded,
	// without effect (contract "Accounts", "Mesh records").
	Opaque bool
}

func (r *Record) MarshalJSON() ([]byte, error) {
	return json.Marshal(signedJSON{Body: ident.B64.EncodeToString(r.Body), Sig: ident.B64.EncodeToString(r.Sig)})
}

// UnmarshalJSON decodes the wire form; call Verify before trusting it.
func (r *Record) UnmarshalJSON(b []byte) error {
	body, sig, err := decodeSigned(b, strictUnmarshal)
	if err != nil {
		return err
	}
	r.Body, r.Sig = body, sig
	return nil
}

// HashOf is base64url(SHA-256(body)).
func HashOf(body []byte) string {
	sum := sha256.Sum256(body)
	return ident.B64.EncodeToString(sum[:])
}

// Signer is the record's signer key.
func (r *Record) Signer() []byte {
	k, _ := ident.DecodeKey(r.B.By)
	return k
}

// Verify parses the body and checks it is well formed and signed (contract "Records"). It does
// not check mesh membership; Store.Merge does.
func (r *Record) Verify() error {
	if len(r.Body) > maxBody {
		return errors.New("mesh: body over 2048 bytes")
	}
	if !utf8.Valid(r.Body) {
		return errors.New("mesh: body is not UTF-8")
	}
	unknown, err := unknownMembers(r.Body)
	if err != nil {
		return fmt.Errorf("mesh: body: %w", err)
	}
	var head bodyHead
	if err := json.Unmarshal(r.Body, &head); err != nil {
		return fmt.Errorf("mesh: body: %w", err)
	}
	if unknown || !knownTypes[head.Type] {
		return r.verifyOpaque(head)
	}
	var b Body
	if err := strictUnmarshal(r.Body, &b); err != nil {
		return fmt.Errorf("mesh: body: %w", err)
	}
	if err := checkBody(&b, r.Body); err != nil {
		return err
	}
	by, err := ident.DecodeKey(b.By)
	if err != nil {
		return err
	}
	if !ed25519.Verify(by, digest(recordPrefix, r.Body), r.Sig) {
		return errors.New("mesh: record signature")
	}
	r.B = b
	r.Sum = sha256.Sum256(r.Body)
	r.Hash = ident.B64.EncodeToString(r.Sum[:])
	return nil
}

var knownTypes = map[string]bool{TypeFound: true, TypeAdmit: true, TypeRevoke: true, TypeName: true,
	TypeHostKeys: true, TypeAccount: true, TypeLock: true}

var bodyNames = strictjson.Names(&Body{})

// unknownMembers reports a member name this version does not know. A duplicate name, or one that
// differs from a known name only by case, is malformed.
func unknownMembers(body []byte) (bool, error) {
	keys, err := strictjson.Keys(body)
	if err != nil {
		return false, err
	}
	unknown := false
	for _, k := range keys {
		if bodyNames[k] {
			continue
		}
		for known := range bodyNames {
			if strings.EqualFold(k, known) {
				return false, fmt.Errorf("member %q differs from %q only by case", k, known)
			}
		}
		unknown = true
	}
	return unknown, nil
}

// verifyOpaque checks what every record shares (head and signature) for a record this version
// gives no effect. A found is never opaque: the mesh id hashes it.
func (r *Record) verifyOpaque(h bodyHead) error {
	b := Body{V: h.V, Mesh: h.Mesh, Type: h.Type, By: h.By, N: h.N, Prev: h.Prev, At: h.At}
	if h.Type == "" || h.Type == TypeFound {
		return errors.New("mesh: unknown record with no type or a found")
	}
	if err := checkHead(&b); err != nil {
		return err
	}
	if b.Mesh == foundMesh || b.Mesh == "" || len(b.Prev) < 1 || len(b.Prev) > maxPrev {
		return errors.New("mesh: record mesh or prev count")
	}
	by, err := ident.DecodeKey(b.By)
	if err != nil {
		return err
	}
	if !ed25519.Verify(by, digest(recordPrefix, r.Body), r.Sig) {
		return errors.New("mesh: record signature")
	}
	r.B, r.Opaque = b, true
	r.Sum = sha256.Sum256(r.Body)
	r.Hash = ident.B64.EncodeToString(r.Sum[:])
	return nil
}

func validHash(h string) bool {
	if len(h) != hashLen {
		return false
	}
	b, err := ident.B64.DecodeString(h)
	return err == nil && len(b) == 32
}

func checkHead(b *Body) error {
	if b.V != 1 && b.V != EpochShared || b.N < 1 {
		return errors.New("mesh: body v or n")
	}
	if b.Prev == nil {
		return errors.New("mesh: body has no prev")
	}
	seen := map[string]bool{}
	for _, h := range b.Prev {
		if !validHash(h) || seen[h] {
			return errors.New("mesh: bad prev")
		}
		seen[h] = true
	}
	return nil
}

func checkBody(b *Body, raw []byte) error {
	if err := checkHead(b); err != nil {
		return err
	}
	hasCard := b.Card != nil
	hasRevoke := b.Subjects != nil || b.Compromised != nil
	hasName := b.Subject != "" || b.Name != ""
	hasKeys := b.Keys != nil || b.User != nil
	hasAccount := b.LoginURL != nil || b.LoginKey != nil || b.Sub != nil
	hasLock := b.On != nil
	hasVia := b.Via != nil || b.Email != nil || b.Assertion != nil
	extras := 0
	for _, x := range []bool{hasCard, hasRevoke, hasName, hasKeys, hasAccount, hasLock} {
		if x {
			extras++
		}
	}
	if extras > 1 {
		return errors.New("mesh: body mixes record types")
	}
	if b.Type == TypeFound {
		if b.Mesh != foundMesh || len(b.Prev) != 0 || b.N != 1 {
			return errors.New("mesh: found must have mesh \"-\", no prev and n 1")
		}
	} else if b.Mesh == foundMesh || len(b.Prev) < 1 || len(b.Prev) > maxPrev {
		return errors.New("mesh: record mesh or prev count")
	}
	switch b.Type {
	case TypeFound, TypeAdmit:
		if !hasCard {
			return errors.New("mesh: missing card")
		}
		if err := b.Card.Verify(); err != nil {
			return err
		}
		c := b.Card.C
		if b.Type == TypeFound {
			if c.Mesh != foundMesh || c.Inviter != foundMesh || c.SignPub != b.By {
				return errors.New("mesh: founder card must be the signer's with mesh and inviter \"-\"")
			}
		} else {
			by, err := ident.DecodeKey(b.By)
			if err != nil {
				return err
			}
			if c.Mesh != b.Mesh || c.Inviter != ident.NodeID(by) {
				return errors.New("mesh: admit card does not name this mesh and signer")
			}
			if hasVia {
				if err := checkVia(b); err != nil {
					return err
				}
			}
		}
	case TypeRevoke:
		if b.Compromised == nil || len(b.Subjects) < 1 || len(b.Subjects) > maxSubjects {
			return errors.New("mesh: revoke needs 1 to 16 subjects and compromised")
		}
		seen := map[string]bool{}
		for _, s := range b.Subjects {
			if _, err := ident.DecodeKey(s); err != nil || seen[s] {
				return errors.New("mesh: bad revoke subject")
			}
			seen[s] = true
		}
	case TypeName:
		if _, err := ident.DecodeKey(b.Subject); err != nil || !ident.ValidName(b.Name) {
			return errors.New("mesh: bad name record")
		}
	case TypeHostKeys:
		if !hasKeys || len(b.Keys) > maxHostKeys {
			return errors.New("mesh: hostkeys needs 0 to 8 keys")
		}
		for _, k := range b.Keys {
			if !validHostKey(k) {
				return fmt.Errorf("mesh: bad host key %q", k)
			}
		}
		if b.User != nil && !ValidUser(*b.User) {
			return fmt.Errorf("mesh: bad hostkeys user %q", *b.User)
		}
	case TypeAccount:
		if _, err := accountOf(b); err != nil {
			return err
		}
	case TypeLock:
		if b.On == nil {
			return errors.New("mesh: lock needs on")
		}
	default:
		return fmt.Errorf("mesh: unknown record type %q", b.Type)
	}
	isCardType := b.Type == TypeFound || b.Type == TypeAdmit
	if (!isCardType && hasCard) || (b.Type != TypeRevoke && hasRevoke) || (b.Type != TypeName && hasName) || (b.Type != TypeHostKeys && hasKeys) ||
		(b.Type != TypeAccount && hasAccount) || (b.Type != TypeLock && hasLock) || (b.Type != TypeAdmit && hasVia) {
		return errors.New("mesh: field does not belong to this record type")
	}
	return nil
}

func checkVia(b *Body) error {
	if b.Via == nil || *b.Via != ViaGoogle || b.Email == nil || b.Assertion == nil {
		return errors.New("mesh: an admit via google needs via, email and assertion")
	}
	if len(*b.Email) < 1 || len(*b.Email) > maxEmail || !validHash(*b.Assertion) {
		return errors.New("mesh: admit email or assertion hash")
	}
	return nil
}

// accountOf parses an account record's binding; nil means unbind ({"sub":null}).
func accountOf(b *Body) (*Account, error) {
	if b.Sub == nil {
		return nil, errors.New("mesh: account needs sub")
	}
	if string(b.Sub) == "null" {
		if b.LoginURL != nil || b.LoginKey != nil {
			return nil, errors.New("mesh: an unbind has only sub null")
		}
		return nil, nil
	}
	var sub string
	if err := json.Unmarshal(b.Sub, &sub); err != nil || sub == "" || len(sub) > maxSub {
		return nil, errors.New("mesh: account sub")
	}
	if b.LoginURL == nil || b.LoginKey == nil || !validLoginURL(*b.LoginURL) {
		return nil, errors.New("mesh: account needs loginUrl and loginKey")
	}
	k, err := ident.DecodeKey(b.LoginKey.Pub)
	if err != nil || login.Kid(k) != b.LoginKey.Kid {
		return nil, errors.New("mesh: account loginKey kid does not match its key")
	}
	return &Account{LoginURL: *b.LoginURL, LoginKey: *b.LoginKey, Sub: sub}, nil
}

// validLoginURL accepts an https URL with no path beyond "/" (http only for loopback test services).
func validLoginURL(s string) bool {
	if len(s) > maxLoginURL {
		return false
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil || (u.Path != "" && u.Path != "/") {
		return false
	}
	return u.Scheme == "https" || u.Scheme == "http" && loopback(u.Hostname())
}

// ValidUser reports whether s is a hostkeys login name: [a-z_][a-z0-9_.-]{0,31}.
func ValidUser(s string) bool {
	if len(s) < 1 || len(s) > 32 {
		return false
	}
	for i, c := range s {
		lower := c >= 'a' && c <= 'z' || c == '_'
		if i == 0 && !lower {
			return false
		}
		if !lower && !(c >= '0' && c <= '9') && c != '.' && c != '-' {
			return false
		}
	}
	return true
}

func validHostKey(k string) bool {
	if len(k) == 0 || len(k) > maxHostKeyLine || strings.ContainsAny(k, "\r\n\x00") {
		return false
	}
	f := strings.Fields(k)
	return len(f) >= 2 && (strings.HasPrefix(f[0], "ssh-") || strings.HasPrefix(f[0], "ecdsa-") || strings.HasPrefix(f[0], "sk-"))
}

var strictUnmarshal = strictjson.Unmarshal

// bodyHead is the common prefix of every record body, in field order.
type bodyHead struct {
	V    int      `json:"v"`
	Mesh string   `json:"mesh"`
	Type string   `json:"type"`
	By   string   `json:"by"`
	N    uint64   `json:"n"`
	Prev []string `json:"prev"`
	At   int64    `json:"at"`
}

// Fields are a record's type-specific members.
type Fields struct {
	Card        *Card
	Subjects    []string
	Compromised bool
	Subject     string
	Name        string
	Keys        []string
	// User is the hostkeys record's SSH login name (optional).
	User string
	// Bind is an account record's binding; nil signs an unbind.
	Bind *Account
	// On is a lock record's state.
	On bool
	// Via, Email and Assertion mark an admit made for a Google account assertion.
	Via, Email, Assertion string
}

// EpochShared is the body version of every record of a mesh that shares its record space out by
// admission lineage (ADR-0026). A mesh's epoch is its found record's version, so it is part of the
// mesh id, and nodes that only know version 1 drop every record of such a mesh.
const EpochShared = 2

// Sign builds and signs a version 1 record body.
func Sign(id *ident.Identity, mesh, typ string, n uint64, prev []string, at int64, f Fields) (*Record, error) {
	return SignV(1, id, mesh, typ, n, prev, at, f)
}

// SignV builds and signs a record body of version v (1, or EpochShared).
func SignV(version int, id *ident.Identity, mesh, typ string, n uint64, prev []string, at int64, f Fields) (*Record, error) {
	// Nodes before 0.2.6 sign and apply these, so stored ones still count everywhere; this node
	// only refuses to make one (its text reaches terminals; pen ls prints it replaced).
	if !login.Printable(f.Email) || f.Bind != nil && !login.Printable(f.Bind.Sub) {
		return nil, errors.New("mesh: an email or sub with a control character")
	}
	if prev == nil {
		prev = []string{}
	}
	h := bodyHead{V: version, Mesh: mesh, Type: typ, By: ident.B64.EncodeToString(id.SignPub), N: n, Prev: prev, At: at}
	var v any
	switch typ {
	case TypeFound:
		v = struct {
			bodyHead
			Card *Card `json:"card"`
		}{h, f.Card}
	case TypeAdmit:
		v = struct {
			bodyHead
			Card      *Card  `json:"card"`
			Via       string `json:"via,omitempty"`
			Email     string `json:"email,omitempty"`
			Assertion string `json:"assertion,omitempty"`
		}{h, f.Card, f.Via, f.Email, f.Assertion}
	case TypeAccount:
		if f.Bind == nil {
			v = struct {
				bodyHead
				Sub *string `json:"sub"`
			}{h, nil}
		} else {
			v = struct {
				bodyHead
				LoginURL string   `json:"loginUrl"`
				LoginKey LoginKey `json:"loginKey"`
				Sub      string   `json:"sub"`
			}{h, f.Bind.LoginURL, f.Bind.LoginKey, f.Bind.Sub}
		}
	case TypeLock:
		v = struct {
			bodyHead
			On bool `json:"on"`
		}{h, f.On}
	case TypeRevoke:
		v = struct {
			bodyHead
			Subjects    []string `json:"subjects"`
			Compromised bool     `json:"compromised"`
		}{h, f.Subjects, f.Compromised}
	case TypeName:
		v = struct {
			bodyHead
			Subject string `json:"subject"`
			Name    string `json:"name"`
		}{h, f.Subject, f.Name}
	case TypeHostKeys:
		keys := f.Keys
		if keys == nil {
			keys = []string{}
		}
		v = struct {
			bodyHead
			Keys []string `json:"keys"`
			User string   `json:"user,omitempty"`
		}{h, keys, f.User}
	default:
		return nil, fmt.Errorf("mesh: unknown record type %q", typ)
	}
	body, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	r := &Record{Body: body, Sig: ed25519.Sign(id.SignPriv, digest(recordPrefix, body))}
	if err := r.Verify(); err != nil {
		return nil, err
	}
	return r, nil
}

// MeshIDOf is the mesh id a founding record names.
func MeshIDOf(found *Record) string { return ident.Base32ID(found.Body) }
