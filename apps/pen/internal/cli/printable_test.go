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
