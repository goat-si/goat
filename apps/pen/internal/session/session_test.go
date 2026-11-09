package session

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

func mustID(t *testing.T) *ident.Identity {
	id, err := ident.Generate(nil)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

type result struct {
	s   *Secure
	err error
}

func handshake(t *testing.T, kind byte, initiatorPSK []byte, admit AdmitFunc, payload Payload) (*Secure, *Secure, error, error) {
	t.Helper()
	ctx := context.Background()
	a, b := relay.Pipe()
	resp, init := mustID(t), mustID(t)
	rc := make(chan result, 1)
	go func() {
		s, err := Respond(ctx, b, resp, resp.NodeID(), admit)
		rc <- result{s, err}
	}()
	is, ierr := Initiate(ctx, a, kind, resp.NodeID(), resp.NoisePub, init, initiatorPSK, payload)
	r := <-rc
	if r.err == nil && !bytes.Equal(r.s.RemoteStatic, init.NoisePub) {
		t.Fatal("responder learned the wrong static key")
	}
	return is, r.s, ierr, r.err
}

func exchange(t *testing.T, a, b *Secure) {
	t.Helper()
	ctx := context.Background()
	for _, m := range [][]byte{[]byte("hello"), {}, bytes.Repeat([]byte{1}, MaxPlaintext)} {
		if err := a.Send(m); err != nil {
			t.Fatal(err)
		}
		got, err := b.Recv(ctx)
		if err != nil || !bytes.Equal(got, m) {
			t.Fatalf("recv: %v", err)
		}
		if err := b.Send(m); err != nil {
			t.Fatal(err)
		}
		if got, err := a.Recv(ctx); err != nil || !bytes.Equal(got, m) {
			t.Fatalf("recv back: %v", err)
		}
	}
	if err := a.Send(make([]byte, MaxPlaintext+1)); err == nil {
		t.Fatal("record over 65519 bytes was accepted")
	}
}

func TestIKRoundTripAdmitsMemberAndCarriesRecords(t *testing.T) {
	var seen Payload
	admit := func(kind byte, _ []byte, p Payload) ([]byte, error) { seen = p; return nil, nil }
	a, b, ierr, rerr := handshake(t, KindSession, nil, admit, Payload{V: 1, Stream: "tcp", Port: 22})
	if ierr != nil || rerr != nil {
		t.Fatal(ierr, rerr)
	}
	if seen.Stream != "tcp" || seen.Port != 22 || b.Payload.Port != 22 {
		t.Fatalf("payload %+v", seen)
	}
	exchange(t, a, b)
}

func TestIKpsk2RoundTripWithInvitePSK(t *testing.T) {
	secret := bytes.Repeat([]byte{9}, 32)
	var psk []byte
	admit := func(kind byte, _ []byte, p Payload) ([]byte, error) {
		if kind != KindJoin || p.Invite != InviteID(secret) {
			return nil, &relay.CloseError{Code: wire.CodeNotAdmitted}
		}
		return psk, nil
	}
	ctx := context.Background()
	a, b := relay.Pipe()
	resp, init := mustID(t), mustID(t)
	var err error
	psk, err = JoinPSK(secret, resp.NodeID(), resp.NoisePub)
	if err != nil {
		t.Fatal(err)
	}
	rc := make(chan result, 1)
	go func() { s, err := Respond(ctx, b, resp, resp.NodeID(), admit); rc <- result{s, err} }()
	is, err := Initiate(ctx, a, KindJoin, resp.NodeID(), resp.NoisePub, init, psk, Payload{V: 1, Stream: "join", Invite: InviteID(secret), Name: "b"})
	r := <-rc
	if err != nil || r.err != nil {
		t.Fatal(err, r.err)
	}
	exchange(t, is, r.s)
}

func TestIKpsk2WithWrongPSKClosesBothSides4400(t *testing.T) {
	admit := func(byte, []byte, Payload) ([]byte, error) { return bytes.Repeat([]byte{1}, 32), nil }
	_, _, ierr, rerr := handshake(t, KindJoin, bytes.Repeat([]byte{2}, 32), admit, Payload{V: 1, Stream: "join", Invite: "x"})
	if relay.CodeOf(ierr) != wire.CodeCrypto || relay.CodeOf(rerr) != wire.CodeCrypto {
		t.Fatalf("initiator %v responder %v, want 4400 both", ierr, rerr)
	}
}

func TestNonMemberIsClosed4401Unanswered(t *testing.T) {
	admit := func(byte, []byte, Payload) ([]byte, error) { return nil, errors.New("not a member") }
	_, _, ierr, rerr := handshake(t, KindSession, nil, admit, Payload{V: 1, Stream: "mesh"})
	if relay.CodeOf(ierr) != wire.CodeNotAdmitted || relay.CodeOf(rerr) != wire.CodeNotAdmitted {
		t.Fatalf("initiator %v responder %v, want 4401", ierr, rerr)
	}
}

func TestUnknownKindOrOversizeFirstMessageCloses4400(t *testing.T) {
	ctx := context.Background()
	resp := mustID(t)
	for _, first := range [][]byte{{0x02, 1, 2, 3}, append([]byte{0x01}, make([]byte, 4096)...)} {
		a, b := relay.Pipe()
		a.Send(first)
		_, err := Respond(ctx, b, resp, resp.NodeID(), func(byte, []byte, Payload) ([]byte, error) { return nil, nil })
		if relay.CodeOf(err) != wire.CodeCrypto {
			t.Fatalf("responder %v, want 4400", err)
		}
		if _, err := a.Recv(ctx); relay.CodeOf(err) != wire.CodeCrypto {
			t.Fatalf("initiator saw %v, want 4400", err)
		}
	}
}

func TestTamperedRecordCloses4400(t *testing.T) {
	ctx := context.Background()
	a, b := relay.Pipe()
	resp, init := mustID(t), mustID(t)
	rc := make(chan result, 1)
	go func() {
		s, err := Respond(ctx, b, resp, resp.NodeID(), func(byte, []byte, Payload) ([]byte, error) { return nil, nil })
		rc <- result{s, err}
	}()
	is, err := Initiate(ctx, a, KindSession, resp.NodeID(), resp.NoisePub, init, nil, Payload{V: 1, Stream: "mesh"})
	r := <-rc
	if err != nil || r.err != nil {
		t.Fatal(err, r.err)
	}
	ct, _ := is.send.Encrypt(nil, nil, []byte("x"))
	ct[0] ^= 1
	a.Send(ct)
	if _, err := r.s.Recv(ctx); relay.CodeOf(err) != wire.CodeCrypto {
		t.Fatalf("got %v, want 4400", err)
	}
	if _, err := is.Recv(ctx); relay.CodeOf(err) != wire.CodeCrypto {
		t.Fatalf("peer saw %v, want 4400", err)
	}
}

func TestRekeyEvery2To20MessagesKeepsBothDirectionsInStep(t *testing.T) {
	a, b, ierr, rerr := handshake(t, KindSession, nil, func(byte, []byte, Payload) ([]byte, error) { return nil, nil }, Payload{V: 1, Stream: "mesh"})
	if ierr != nil || rerr != nil {
		t.Fatal(ierr, rerr)
	}
	a.send.SetNonce(RekeyInterval - 2)
	b.recv.SetNonce(RekeyInterval - 2)
	before := a.send.UnsafeKey()
	ctx := context.Background()
	for i := range 4 {
		if err := a.Send([]byte{byte(i)}); err != nil {
			t.Fatal(err)
		}
		got, err := b.Recv(ctx)
		if err != nil || got[0] != byte(i) {
			t.Fatalf("record %d: %v", i, err)
		}
	}
	if a.send.UnsafeKey() == before {
		t.Fatal("key did not change at the 2^20 boundary")
	}
	if a.send.Nonce() != RekeyInterval+2 {
		t.Fatalf("nonce %d: rekey must not reset n", a.send.Nonce())
	}
}
