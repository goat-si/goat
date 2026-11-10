package login_test

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/login"
)

type loginVectors struct {
	Node struct {
		SignSeed, NoisePriv, SignPub, NoisePub, NodeID, Name string
	}
	LoginKey struct{ Seed, Pub, Kid string }
	Start    struct{ Name, Message, Proof string }
	Poll     struct{ DeviceCode, Message, Proof string }
	Forget   struct {
		NodeID         string
		TS             uint64
		Message, Proof string
	}
	Assertion struct{ BodyJSON, Body, Sig, Hash string }
	Checks    []struct {
		Name      string
		Assertion json.RawMessage
		Context   struct {
			Iss, Sub, SignPub, NoisePub string
			Skew                        int64
			Now                         int64
		}
		OK     bool
		Reason *string
	}
}

func unhex(t *testing.T, s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// TestLoginVectorsMatch checks the Go side against packages/pen-protocol/vectors/login.json (TS-generated).
func TestLoginVectorsMatch(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/pen-protocol/vectors/login.json")
	if err != nil {
		t.Fatal(err)
	}
	var v loginVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	node, err := ident.FromSeeds(unhex(t, v.Node.SignSeed), unhex(t, v.Node.NoisePriv))
	if err != nil {
		t.Fatal(err)
	}
	if ident.B64.EncodeToString(node.SignPub) != v.Node.SignPub || node.NodeID() != v.Node.NodeID {
		t.Fatal("node keys")
	}
	loginPriv := ed25519.NewKeyFromSeed(unhex(t, v.LoginKey.Seed))
	loginPub := loginPriv.Public().(ed25519.PublicKey)
	if got := login.Kid(loginPub); got != v.LoginKey.Kid || ident.B64.EncodeToString(loginPub) != v.LoginKey.Pub {
		t.Fatalf("kid %q, want %q", got, v.LoginKey.Kid)
	}
	sign := func(name string, msg []byte, wantMsg, wantProof string) {
		if !bytes.Equal(msg, unhex(t, wantMsg)) {
			t.Fatalf("%s message %x, want %s", name, msg, wantMsg)
		}
		if got := ident.B64.EncodeToString(ed25519.Sign(node.SignPriv, msg)); got != wantProof {
			t.Fatalf("%s proof %s, want %s", name, got, wantProof)
		}
	}
	sign("start", login.StartMessage(node.SignPub, node.NoisePub, v.Start.Name), v.Start.Message, v.Start.Proof)
	sign("poll", login.PollMessage(v.Poll.DeviceCode), v.Poll.Message, v.Poll.Proof)
	sign("forget", login.ForgetMessage(v.Forget.NodeID, v.Forget.TS), v.Forget.Message, v.Forget.Proof)

	var body login.AssertionBody
	if err := json.Unmarshal([]byte(v.Assertion.BodyJSON), &body); err != nil {
		t.Fatal(err)
	}
	a, err := login.Issue(loginPriv, body.Iss, body.Sub, body.Email, node.SignPub, node.NoisePub, time.Unix(body.Iat, 0))
	if err != nil {
		t.Fatal(err)
	}
	if string(a.Body) != v.Assertion.BodyJSON || ident.B64.EncodeToString(a.Sig) != v.Assertion.Sig || a.Hash() != v.Assertion.Hash {
		t.Fatalf("assertion body %s sig %s hash %s", a.Body, ident.B64.EncodeToString(a.Sig), a.Hash())
	}

	key := login.Key{Kid: v.LoginKey.Kid, Pub: v.LoginKey.Pub}
	for _, c := range v.Checks {
		var as login.Assertion
		err := json.Unmarshal(c.Assertion, &as)
		if err == nil {
			b := login.Binding{LoginURL: c.Context.Iss, Key: key, Sub: c.Context.Sub}
			err = as.Check(b, time.Unix(c.Context.Now, 0))
		}
		if err == nil {
			sp, _ := ident.DecodeKey(c.Context.SignPub)
			np, _ := ident.DecodeKey(c.Context.NoisePub)
			if !as.ForKeys(sp, np) {
				err = errors.New("key mismatch")
			}
		}
		if (err == nil) != c.OK {
			t.Fatalf("%s: got %v, want ok=%v (%v)", c.Name, err, c.OK, c.Reason)
		}
		if c.Reason != nil && (*c.Reason == "expired" || *c.Reason == "not_yet_valid") && !errors.Is(err, login.ErrClockSkew) {
			t.Fatalf("%s: %v, want a clock skew refusal", c.Name, err)
		}
	}
}
