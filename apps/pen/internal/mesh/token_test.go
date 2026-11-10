package mesh

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/ident"
)

const tokenVectors = "../../../../packages/pen-protocol/vectors/token.json"

type tokenCase struct {
	Relays []string `json:"relays"`
	Token  string   `json:"token"`
}

type badToken struct {
	Why   string `json:"why"`
	Token string `json:"token"`
}

type tokenFile struct {
	Description string      `json:"description"`
	SignPub     string      `json:"signPub"`
	NoisePub    string      `json:"noisePub"`
	Secret      string      `json:"secret"`
	Valid       []tokenCase `json:"valid"`
	Invalid     []badToken  `json:"invalid"`
}

// rawV2 encodes a version 2 token without validating its relays.
func rawV2(t Token) string {
	b := []byte{2}
	b = append(b, t.SignPub...)
	b = append(b, t.NoisePub...)
	b = append(b, t.Secret...)
	b = append(b, strings.Join(t.Relays, "\n")...)
	return TokenPrefix + ident.B64.EncodeToString(b)
}

func buildTokenVectors() tokenFile {
	id := detID(0x21)
	secret := bytes.Repeat([]byte{0x42}, 32)
	base := Token{SignPub: id.SignPub, NoisePub: id.NoisePub, Secret: secret}
	f := tokenFile{
		Description: "Pen invite tokens. Go-generated: go test ./internal/mesh -run TestTokenVectors -update. " +
			"Version 1 carries one relay URL; version 2 carries 1 to 8 URLs joined by LF, each at most 256 bytes, " +
			"https or wss (http or ws only for loopback hosts), no empties or duplicates. One relay encodes as v1.",
		SignPub: hex.EncodeToString(id.SignPub), NoisePub: hex.EncodeToString(id.NoisePub), Secret: hex.EncodeToString(secret),
	}
	for _, relays := range [][]string{
		{"https://pen-relay.example.workers.dev"},
		{"https://pen-relay.example.workers.dev", "wss://203-0-113-7.sslip.io"},
		{"http://127.0.0.1:8787", "http://localhost:8788"},
	} {
		tok := base
		tok.Relays = relays
		f.Valid = append(f.Valid, tokenCase{Relays: relays, Token: tok.String()})
	}
	many := make([]string, 9)
	for i := range many {
		many[i] = "https://r" + string(rune('a'+i)) + ".example"
	}
	for why, relays := range map[string][]string{
		"nine relays":                 many,
		"duplicate relay":             {"https://a.example", "https://a.example"},
		"one relay spelled twice":     {"https://a.example", "wss://A.example:443"},
		"empty relay":                 {"https://a.example", ""},
		"plain http to a public host": {"https://a.example", "http://b.example"},
		"relay over 256 bytes":        {"https://a.example", "https://" + strings.Repeat("x", 250) + ".example"},
	} {
		tok := base
		tok.Relays = relays
		f.Invalid = append(f.Invalid, badToken{Why: why, Token: rawV2(tok)})
	}
	v1 := base
	v1.Relays = []string{"http://relay.example.com"}
	f.Invalid = append(f.Invalid, badToken{Why: "version 1, plain http to a public host", Token: v1.String()})
	sortBad(f.Invalid)
	return f
}

func sortBad(b []badToken) {
	for i := range b {
		for j := i + 1; j < len(b); j++ {
			if b[j].Why < b[i].Why {
				b[i], b[j] = b[j], b[i]
			}
		}
	}
}

func TestTokenVectors(t *testing.T) {
	got := buildTokenVectors()
	if *update {
		b, _ := json.MarshalIndent(got, "", "  ")
		if err := os.WriteFile(tokenVectors, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(tokenVectors)
	if err != nil {
		t.Fatal(err)
	}
	var want tokenFile
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatal("token.json does not match the implementation")
	}
	for _, c := range want.Valid {
		tok, err := ParseToken(c.Token)
		if err != nil {
			t.Fatalf("%v: %v", c.Relays, err)
		}
		if !reflect.DeepEqual(tok.Relays, c.Relays) || hex.EncodeToString(tok.SignPub) != want.SignPub || hex.EncodeToString(tok.Secret) != want.Secret {
			t.Fatalf("%v parsed as %v", c.Relays, tok.Relays)
		}
		if tok.String() != c.Token {
			t.Fatalf("%v does not re-encode to the same token", c.Relays)
		}
	}
	for _, c := range want.Invalid {
		if _, err := ParseToken(c.Token); err == nil {
			t.Fatalf("%s: token accepted", c.Why)
		}
	}
}
