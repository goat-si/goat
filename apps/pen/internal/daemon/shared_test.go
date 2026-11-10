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
