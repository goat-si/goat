// Package mesh holds the signed record log a mesh agrees on, the view replayed from it, sync and join.
package mesh

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"unicode/utf8"

	"github.com/goat-si/goat/apps/pen/internal/ident"
)

// Record types.
const (
	TypeFound    = "found"
	TypeAdmit    = "admit"
	TypeRevoke   = "revoke"
	TypeName     = "name"
	TypeHostKeys = "hostkeys"
)

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
	body, sig, err := decodeSigned(b)
	if err != nil {
		return err
	}
	c.Body, c.Sig = body, sig
	return nil
}

func decodeSigned(b []byte) ([]byte, []byte, error) {
	var s signedJSON
	if err := strictUnmarshal(b, &s); err != nil {
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
	if err := strictUnmarshal(c.Body, &cb); err != nil {
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
}

// Record is a signed mesh record. Body holds the exact signed bytes.
type Record struct {
	Body []byte
	Sig  []byte
	B    Body
	Hash string
	// Sum is the raw SHA-256 of Body; canonical order compares it as unsigned bytes.
	Sum [32]byte
}

func (r *Record) MarshalJSON() ([]byte, error) {
	return json.Marshal(signedJSON{Body: ident.B64.EncodeToString(r.Body), Sig: ident.B64.EncodeToString(r.Sig)})
}

// UnmarshalJSON decodes the wire form; call Verify before trusting it.
func (r *Record) UnmarshalJSON(b []byte) error {
	body, sig, err := decodeSigned(b)
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

func validHash(h string) bool {
	if len(h) != hashLen {
		return false
	}
	b, err := ident.B64.DecodeString(h)
	return err == nil && len(b) == 32
}

func checkBody(b *Body, raw []byte) error {
	if b.V != 1 || b.N < 1 {
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
	hasCard := b.Card != nil
	hasRevoke := b.Subjects != nil || b.Compromised != nil
	hasName := b.Subject != "" || b.Name != ""
	hasKeys := b.Keys != nil || b.User != nil
	extras := 0
	for _, x := range []bool{hasCard, hasRevoke, hasName, hasKeys} {
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
	default:
		return fmt.Errorf("mesh: unknown record type %q", b.Type)
	}
	isCardType := b.Type == TypeFound || b.Type == TypeAdmit
	if (!isCardType && hasCard) || (b.Type != TypeRevoke && hasRevoke) || (b.Type != TypeName && hasName) || (b.Type != TypeHostKeys && hasKeys) {
		return errors.New("mesh: field does not belong to this record type")
	}
	return nil
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

// strictUnmarshal decodes one JSON object into the struct v points to. Member names must match v's
// JSON names exactly (encoding/json alone matches them case-insensitively); unknown, case-variant
// and duplicate names and trailing data are rejected.
func strictUnmarshal(b []byte, v any) error {
	if err := exactKeys(b, jsonNames(v)); err != nil {
		return err
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	if d.More() {
		return errors.New("trailing data")
	}
	return nil
}

// jsonNames lists the JSON member names of the struct v points to.
func jsonNames(v any) map[string]bool {
	t := reflect.TypeOf(v).Elem()
	names := map[string]bool{}
	for i := 0; i < t.NumField(); i++ {
		tag, _, _ := strings.Cut(t.Field(i).Tag.Get("json"), ",")
		if tag != "" && tag != "-" {
			names[tag] = true
		}
	}
	return names
}

func exactKeys(b []byte, allowed map[string]bool) error {
	d := json.NewDecoder(bytes.NewReader(b))
	t, err := d.Token()
	if err != nil {
		return err
	}
	if t != json.Delim('{') {
		return errors.New("not an object")
	}
	seen := map[string]bool{}
	for d.More() {
		k, err := d.Token()
		if err != nil {
			return err
		}
		ks, _ := k.(string)
		if !allowed[ks] {
			return fmt.Errorf("unknown member %q", ks)
		}
		if seen[ks] {
			return fmt.Errorf("duplicate member %q", ks)
		}
		seen[ks] = true
		var skip json.RawMessage
		if err := d.Decode(&skip); err != nil {
			return err
		}
	}
	return nil
}

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
}

// Sign builds and signs a record body.
func Sign(id *ident.Identity, mesh, typ string, n uint64, prev []string, at int64, f Fields) (*Record, error) {
	if prev == nil {
		prev = []string{}
	}
	h := bodyHead{V: 1, Mesh: mesh, Type: typ, By: ident.B64.EncodeToString(id.SignPub), N: n, Prev: prev, At: at}
	var v any
	switch typ {
	case TypeFound, TypeAdmit:
		v = struct {
			bodyHead
			Card *Card `json:"card"`
		}{h, f.Card}
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
