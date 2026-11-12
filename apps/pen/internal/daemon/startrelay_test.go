package daemon

import (
	"strings"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/state"
)

// A config written by an older build or by hand may name a plain-http public relay, which this
// node's invites could not carry. The daemon refuses to start on it and says how to fix it.
func TestTheDaemonRefusesAStoredPlainHTTPPublicRelay(t *testing.T) {
	st := shortDir(t)
	if _, _, err := st.EnsureIdentity(); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveConfig(state.Config{Relay: "http://relay.example", Name: "a"}); err != nil {
		t.Fatal(err)
	}
	_, err := New(Options{Store: st, HostKeyGlob: "none", KnownHosts: "none"})
	if err == nil || !strings.Contains(err.Error(), "pen relay") {
		t.Fatalf("start with http://relay.example: %v, want a refusal naming pen relay", err)
	}
}
