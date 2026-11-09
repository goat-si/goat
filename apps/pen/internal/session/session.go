// Package session runs the Pen Noise handshakes (IK and IKpsk2) and the record layer over a relay link.
package session

import (
	"bytes"
	"context"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/flynn/noise"
	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// Session kinds (first byte of a session's first message).
const (
	KindSession byte = 0x01
	KindJoin    byte = 0x03
)

const (
	// MaxPlaintext is the largest plaintext in one record.
	MaxPlaintext = 65519
	// RekeyInterval is the per-direction message count between REKEY()s.
	RekeyInterval = 1 << 20
	// HandshakeTimeout bounds a handshake from first message to key confirmation.
	HandshakeTimeout = 10 * time.Second
	maxFirstMessage  = 4096
	maxPayload       = 256
)

var suite = noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashBLAKE2s)

// Prologue is "pen/1" || nodeId || kind.
func Prologue(nodeID string, kind byte) []byte {
	return append([]byte("pen/1"+nodeID), kind)
}

// Payload is a handshake message 1 payload.
type Payload struct {
	V      int    `json:"v"`
	Stream string `json:"stream"`
	Port   int    `json:"port,omitempty"`
	Invite string `json:"invite,omitempty"`
	Name   string `json:"name,omitempty"`
}

// EncodePayload renders a payload as one JSON line.
func EncodePayload(p any) ([]byte, error) {
	b, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	b = append(b, '\n')
	if len(b) > maxPayload {
		return nil, errors.New("session: handshake payload over 256 bytes")
	}
	return b, nil
}

func decodeLine(b []byte, v any) error {
	if len(b) == 0 || len(b) > maxPayload || b[len(b)-1] != '\n' || bytes.IndexByte(b[:len(b)-1], '\n') >= 0 {
		return errors.New("session: payload is not one JSON line")
	}
	if err := json.Unmarshal(b[:len(b)-1], v); err != nil {
		return fmt.Errorf("session: payload: %w", err)
	}
	return nil
}

var msg2Payload = []byte("{\"v\":1}\n")

// InviteID is base64url(SHA-256("pen/1 invite" || secret)[0..12]).
func InviteID(secret []byte) string {
	sum := sha256.Sum256(append([]byte("pen/1 invite"), secret...))
	return ident.B64.EncodeToString(sum[:12])
}

// JoinPSK is HKDF-SHA256(secret, salt empty, info "pen/1 join psk" || nodeId || noisePub, 32).
func JoinPSK(secret []byte, nodeID string, noisePub []byte) ([]byte, error) {
	info := append([]byte("pen/1 join psk"+nodeID), noisePub...)
	return hkdf.Key(sha256.New, secret, nil, string(info), 32)
}

func config(kind byte, nodeID string, initiator bool, local *ident.Identity, peer []byte, rng io.Reader) noise.Config {
	c := noise.Config{
		CipherSuite:   suite,
		Random:        rng,
		Pattern:       noise.HandshakeIK,
		Initiator:     initiator,
		Prologue:      Prologue(nodeID, kind),
		StaticKeypair: local.NoiseKey(),
		PeerStatic:    peer,
	}
	if kind == KindJoin {
		c.PresharedKeyPlacement = 2
	}
	return c
}

// Secure is an established session: Noise transport records over a relay link.
type Secure struct {
	conn relay.Conn

	sendMu sync.Mutex
	send   *noise.CipherState
	recv   *noise.CipherState

	// RemoteStatic is the peer's Noise static key; Payload is message 1's payload (responder side).
	RemoteStatic []byte
	Kind         byte
	Payload      Payload
}

// Send encrypts one record (at most MaxPlaintext bytes).
func (s *Secure) Send(p []byte) error {
	if len(p) > MaxPlaintext {
		return errors.New("session: record over 65519 bytes")
	}
	s.sendMu.Lock()
	ct, err := s.send.Encrypt(nil, nil, p)
	if err == nil && s.send.Nonce()%RekeyInterval == 0 {
		s.send.Rekey()
	}
	if err != nil {
		s.sendMu.Unlock()
		return err
	}
	err = s.conn.Send(ct)
	s.sendMu.Unlock()
	return err
}

// Recv returns the next record's plaintext. A record that fails to decrypt closes the session 4400.
func (s *Secure) Recv(ctx context.Context) ([]byte, error) {
	ct, err := s.conn.Recv(ctx)
	if err != nil {
		return nil, err
	}
	pt, err := s.recv.Decrypt(nil, nil, ct)
	if err != nil {
		s.conn.Close(wire.CodeCrypto)
		return nil, &relay.CloseError{Code: wire.CodeCrypto}
	}
	if s.recv.Nonce()%RekeyInterval == 0 {
		s.recv.Rekey()
	}
	return pt, nil
}

// Close closes the underlying link with code.
func (s *Secure) Close(code uint16) error { return s.conn.Close(code) }

// Initiate runs the initiator side to the responder nodeID with static remoteNoisePub.
// psk is required for KindJoin and ignored otherwise.
func Initiate(ctx context.Context, conn relay.Conn, kind byte, nodeID string, remoteNoisePub []byte, local *ident.Identity, psk []byte, payload any) (*Secure, error) {
	return initiate(ctx, conn, kind, nodeID, remoteNoisePub, local, psk, payload, nil)
}

func initiate(ctx context.Context, conn relay.Conn, kind byte, nodeID string, remoteNoisePub []byte, local *ident.Identity, psk []byte, payload any, rng io.Reader) (*Secure, error) {
	ctx, cancel := context.WithTimeout(ctx, HandshakeTimeout)
	defer cancel()
	line, err := EncodePayload(payload)
	if err != nil {
		return nil, err
	}
	hs, err := noise.NewHandshakeState(config(kind, nodeID, true, local, remoteNoisePub, rng))
	if err != nil {
		return nil, err
	}
	if kind == KindJoin {
		if err := hs.SetPresharedKey(psk); err != nil {
			return nil, err
		}
	}
	m1, _, _, err := hs.WriteMessage([]byte{kind}, line)
	if err != nil {
		return nil, err
	}
	if err := conn.Send(m1); err != nil {
		return nil, err
	}
	m2, err := conn.Recv(ctx)
	if err != nil {
		if ctx.Err() != nil {
			conn.Close(wire.CodeTimeout)
			return nil, &relay.CloseError{Code: wire.CodeTimeout}
		}
		return nil, err
	}
	p2, cs1, cs2, err := hs.ReadMessage(nil, m2)
	if err != nil || !bytes.Equal(p2, msg2Payload) || cs1 == nil {
		conn.Close(wire.CodeCrypto)
		return nil, &relay.CloseError{Code: wire.CodeCrypto}
	}
	s := &Secure{conn: conn, send: cs1, recv: cs2, RemoteStatic: remoteNoisePub, Kind: kind}
	if err := s.Send(nil); err != nil {
		return nil, err
	}
	raiseQueue(conn)
	return s, nil
}

// AdmitFunc decides on a session after message 1. It returns the psk for KindJoin. A *relay.CloseError
// selects the close code (default 4401); the session closes unanswered.
type AdmitFunc func(kind byte, remoteStatic []byte, p Payload) (psk []byte, err error)

// Respond runs the responder side for this node (nodeID) and returns once the initiator confirmed.
func Respond(ctx context.Context, conn relay.Conn, local *ident.Identity, nodeID string, admit AdmitFunc) (*Secure, error) {
	return respond(ctx, conn, local, nodeID, admit, nil)
}

func respond(ctx context.Context, conn relay.Conn, local *ident.Identity, nodeID string, admit AdmitFunc, rng io.Reader) (*Secure, error) {
	ctx, cancel := context.WithTimeout(ctx, HandshakeTimeout)
	defer cancel()
	fail := func(code uint16) (*Secure, error) {
		conn.Close(code)
		return nil, &relay.CloseError{Code: code}
	}
	timeoutOr := func(err error) (*Secure, error) {
		if ctx.Err() != nil {
			return fail(wire.CodeTimeout)
		}
		return nil, err
	}
	m1, err := conn.Recv(ctx)
	if err != nil {
		return timeoutOr(err)
	}
	if len(m1) < 1 || len(m1) > maxFirstMessage || (m1[0] != KindSession && m1[0] != KindJoin) {
		return fail(wire.CodeCrypto)
	}
	kind := m1[0]
	hs, err := noise.NewHandshakeState(config(kind, nodeID, false, local, nil, rng))
	if err != nil {
		return nil, err
	}
	line, _, _, err := hs.ReadMessage(nil, m1[1:])
	if err != nil {
		return fail(wire.CodeCrypto)
	}
	var p Payload
	if err := decodeLine(line, &p); err != nil || p.V != 1 {
		return fail(wire.CodeCrypto)
	}
	remote := append([]byte(nil), hs.PeerStatic()...)
	psk, err := admit(kind, remote, p)
	if err != nil {
		code := relay.CodeOf(err)
		if code == 0 {
			code = wire.CodeNotAdmitted
		}
		return fail(code)
	}
	if kind == KindJoin {
		if err := hs.SetPresharedKey(psk); err != nil {
			return fail(wire.CodeNotAdmitted)
		}
	}
	m2, cs1, cs2, err := hs.WriteMessage(nil, msg2Payload)
	if err != nil || cs1 == nil {
		return fail(wire.CodeCrypto)
	}
	if err := conn.Send(m2); err != nil {
		return nil, err
	}
	s := &Secure{conn: conn, send: cs2, recv: cs1, RemoteStatic: remote, Kind: kind, Payload: p}
	confirm, err := s.Recv(ctx)
	if err != nil {
		if relay.CodeOf(err) == wire.CodeCrypto {
			return nil, err
		}
		return timeoutOr(err)
	}
	if len(confirm) != 0 {
		return fail(wire.CodeCrypto)
	}
	raiseQueue(conn)
	return s, nil
}

// raiseQueue lifts the link's receive cap once the peer is authenticated.
func raiseQueue(conn relay.Conn) {
	if l, ok := conn.(relay.QueueLimiter); ok {
		l.SetQueueLimit(relay.MaxQueued)
	}
}
