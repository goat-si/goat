// Package ident holds a node's keys and the names derived from them.
package ident

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/flynn/noise"
)

// B64 is the base64url alphabet without padding used on the wire.
var B64 = base64.RawURLEncoding

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// Identity is a node's signing (Ed25519) and Noise static (X25519) key pairs.
type Identity struct {
	SignPriv  ed25519.PrivateKey
	SignPub   ed25519.PublicKey
	NoisePriv []byte
	NoisePub  []byte
}

// Generate creates a fresh identity from r (crypto/rand when nil).
func Generate(r io.Reader) (*Identity, error) {
	if r == nil {
		r = rand.Reader
	}
	seed := make([]byte, ed25519.SeedSize)
	if _, err := io.ReadFull(r, seed); err != nil {
		return nil, err
	}
	noisePriv := make([]byte, 32)
	if _, err := io.ReadFull(r, noisePriv); err != nil {
		return nil, err
	}
	return FromSeeds(seed, noisePriv)
}

// FromSeeds rebuilds an identity from its Ed25519 seed and X25519 private key.
func FromSeeds(signSeed, noisePriv []byte) (*Identity, error) {
	if len(signSeed) != ed25519.SeedSize || len(noisePriv) != 32 {
		return nil, errors.New("ident: bad key length")
	}
	priv := ed25519.NewKeyFromSeed(signSeed)
	pub, err := NoisePublic(noisePriv)
	if err != nil {
		return nil, err
	}
	return &Identity{
		SignPriv:  priv,
		SignPub:   priv.Public().(ed25519.PublicKey),
		NoisePriv: append([]byte(nil), noisePriv...),
		NoisePub:  pub,
	}, nil
}

// NoisePublic derives the X25519 public key of priv.
func NoisePublic(priv []byte) ([]byte, error) {
	k, err := ecdh.X25519().NewPrivateKey(priv)
	if err != nil {
		return nil, err
	}
	return k.PublicKey().Bytes(), nil
}

// NodeID is the node's relay address: base32 of the first 16 bytes of SHA-256(signPub).
func (id *Identity) NodeID() string { return NodeID(id.SignPub) }

// NoiseKey is the static key in flynn/noise form.
func (id *Identity) NoiseKey() noise.DHKey {
	return noise.DHKey{Private: id.NoisePriv, Public: id.NoisePub}
}

// NodeID derives a nodeId from an Ed25519 public key.
func NodeID(signPub []byte) string {
	sum := sha256.Sum256(signPub)
	return strings.ToLower(b32.EncodeToString(sum[:16]))
}

// Base32ID is the lowercase unpadded base32 of the first 16 bytes of SHA-256(b) (nodeId and mesh id rule).
func Base32ID(b []byte) string {
	sum := sha256.Sum256(b)
	return strings.ToLower(b32.EncodeToString(sum[:16]))
}

// Fingerprint is the first 20 bytes of SHA-256(noisePub) as 10 groups of 4 uppercase hex digits.
func Fingerprint(noisePub []byte) string {
	sum := sha256.Sum256(noisePub)
	h := strings.ToUpper(hex.EncodeToString(sum[:20]))
	groups := make([]string, 0, 10)
	for i := 0; i < len(h); i += 4 {
		groups = append(groups, h[i:i+4])
	}
	return strings.Join(groups, " ")
}

// ValidNodeID reports whether s is 26 characters of [a-z2-7].
func ValidNodeID(s string) bool {
	if len(s) != 26 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= '2' && c <= '7') {
			return false
		}
	}
	return true
}

// ValidName reports whether s is a node name: 1 to 32 of [a-z0-9-_.], starting with a letter or digit.
func ValidName(s string) bool {
	if len(s) < 1 || len(s) > 32 {
		return false
	}
	for i, c := range s {
		alnum := c >= 'a' && c <= 'z' || c >= '0' && c <= '9'
		if i == 0 && !alnum {
			return false
		}
		if !alnum && c != '-' && c != '_' && c != '.' {
			return false
		}
	}
	return true
}

// DecodeKey decodes a base64url (no padding) 32-byte key.
func DecodeKey(s string) ([]byte, error) {
	b, err := B64.DecodeString(s)
	if err != nil || len(b) != 32 {
		return nil, fmt.Errorf("ident: bad key %q", s)
	}
	return b, nil
}

