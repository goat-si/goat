package wire

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

type relayVectors struct {
	SignSeed, NodeID, RelayOrigin, Challenge, ChallengeMessage, Signature, Answer string
	Origins                                                                   []struct{ URL, Origin string }
	Frames                                                                    []struct {
		Type    byte
		SID     uint32
		Payload string
		Hex     string
	}
	Acks []struct {
		Text  string
		Value *uint64
	}
}

func unhex(t *testing.T, s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestVectorsMatchChallengeFramesOriginsAndAcks(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/pen-protocol/vectors/relay.json")
	if err != nil {
		t.Fatal(err)
	}
	var v relayVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	msg := ChallengeMessage(v.RelayOrigin, v.NodeID, unhex(t, v.Challenge))
	if hex.EncodeToString(msg) != v.ChallengeMessage {
		t.Fatal("challenge message differs")
	}
	priv := ed25519.NewKeyFromSeed(unhex(t, v.SignSeed))
	sig := ed25519.Sign(priv, msg)
	if hex.EncodeToString(sig) != v.Signature {
		t.Fatal("signature differs")
	}
	answer := append(append([]byte(nil), priv.Public().(ed25519.PublicKey)...), sig...)
	if hex.EncodeToString(answer) != v.Answer {
		t.Fatal("answer differs")
	}
	for _, o := range v.Origins {
		if got, err := RelayOrigin(o.URL); err != nil || got != o.Origin {
			t.Fatalf("RelayOrigin(%s) = %s, %v; want %s", o.URL, got, err, o.Origin)
		}
	}
	for _, f := range v.Frames {
		fr := Frame{Type: f.Type, SID: f.SID, Payload: unhex(t, f.Payload)}
		if hex.EncodeToString(fr.Encode()) != f.Hex {
			t.Fatalf("frame %+v encodes differently", f)
		}
		back, err := DecodeFrame(unhex(t, f.Hex))
		if err != nil || back.Type != f.Type || back.SID != f.SID || !bytes.Equal(back.Payload, fr.Payload) {
			t.Fatalf("frame %s decodes to %+v, %v", f.Hex, back, err)
		}
	}
	for _, a := range v.Acks {
		n, ok := ParseAck(a.Text)
		if ok != (a.Value != nil) || ok && n != *a.Value {
			t.Fatalf("ParseAck(%q) = %d, %v", a.Text, n, ok)
		}
	}
}

func TestReservedFrameTypesAreRejected(t *testing.T) {
	for typ := byte(4); typ <= 7; typ++ {
		if _, err := DecodeFrame([]byte{typ, 1, 0, 0, 0}); err != ErrReserved {
			t.Fatalf("type %d: %v", typ, err)
		}
	}
}

