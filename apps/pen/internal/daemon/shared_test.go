package daemon

import "testing"

// A node's only relay ends up in a version 1 invite, which refuses plain http to a public host, so
// the node must refuse that relay too instead of printing invites no joiner can use.
func TestASingleRelayFollowsTheInviteSchemeRule(t *testing.T) {
	for _, ok := range []string{"https://relay.example", "wss://relay.example", "http://127.0.0.1:8787", "ws://localhost:1"} {
		if err := ValidRelays([]string{ok}); err != nil {
			t.Fatalf("%s: %v", ok, err)
		}
	}
	for _, bad := range []string{"http://relay.example", "ws://203.0.113.7", "ftp://relay.example"} {
		if ValidRelays([]string{bad}) == nil {
			t.Fatalf("%s accepted as the only relay", bad)
		}
	}
}
