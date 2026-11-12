package cli

import (
	"bytes"
	"strings"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
)

// Records stored before control characters were refused still print without them.
func TestAccountFieldsPrintWithoutControlCharacters(t *testing.T) {
	var w bytes.Buffer
	printAccount(&w, daemon.LsReply{Account: &mesh.Account{Sub: "1\x1b[2J", LoginURL: "https://login.example"}})
	printPending(&w, daemon.Pending{ID: "1234", Name: "n", NodeID: "abcdefgh", Email: "e\x1b]0;x\x07@x"})
	w.WriteString(via(mesh.Member{Via: mesh.ViaGoogle, Email: "m\x7f@x"}))
	if s := w.String(); strings.ContainsAny(s, "\x1b\x07\x7f") {
		t.Fatalf("printed control characters: %q", s)
	}
}

// A mesh bound by an older node can name an account whose sub holds control characters; pen login's
// rebind questions print it, and the sign-in service's email, without them.
func TestLoginBindQuestionsPrintWithoutControlCharacters(t *testing.T) {
	old := &mesh.Account{Sub: "1\x1b[2J", LoginURL: "https://login.example", LoginKey: mesh.LoginKey{Kid: "aaaaaaaa"}}
	want := mesh.Account{Sub: "2", LoginURL: "https://login.example", LoginKey: mesh.LoginKey{Kid: "bbbbbbbb"}}
	email := "e\x1b]0;x\x07@x"
	for _, q := range []string{
		bindAgainQuestion("m", nil, want, email),
		bindAgainQuestion("m", old, want, email),
		bindAgainQuestion("m", &mesh.Account{Sub: "2\x7f"}, mesh.Account{Sub: "2\x7f"}, email),
		otherAccountWarning("m", old.Sub),
	} {
		if strings.ContainsAny(q, "\x1b\x07\x7f") {
			t.Fatalf("printed control characters: %q", q)
		}
	}
}
