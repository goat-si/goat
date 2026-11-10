package daemon

import "testing"

func TestInstallAndLoginCommandsQuoteADownloadRelayThatIsNotPlain(t *testing.T) {
	if got := LoginCommand("https://pen-relay.example"); got != "curl -fsSL https://pen-relay.example/install.sh | sh -s -- --login" {
		t.Fatalf("plain relay: %q", got)
	}
	// A hand-edited config.json bypasses pen relay download's check; the printed command must stay inert.
	got := InstallCommand("https://a$(id)';b", "tok_EN-1")
	want := `curl -fsSL 'https://a$(id)'\'';b/install.sh' | sh -s -- --join tok_EN-1`
	if got != want {
		t.Fatalf("hostile relay:\n got %s\nwant %s", got, want)
	}
}

func TestWindowsInstallAndLoginCommandsKeepTheirValuesInert(t *testing.T) {
	if got := LoginCommandWindows("https://pen-relay.example"); got != "& ([scriptblock]::Create((irm 'https://pen-relay.example/install.ps1'))) --login" {
		t.Fatalf("plain relay: %q", got)
	}
	got := InstallCommandWindows("https://a$(id)';b", "tok_EN-1")
	want := "& ([scriptblock]::Create((irm 'https://a$(id)'';b/install.ps1'))) --join 'tok_EN-1'"
	if got != want {
		t.Fatalf("hostile relay:\n got %s\nwant %s", got, want)
	}
}

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
