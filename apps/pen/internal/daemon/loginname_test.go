package daemon

import "testing"

// A Windows member publishes the login ssh needs for a local account and nothing for a domain account.
func TestLocalAccountNameKeepsOnlyThisComputersAccounts(t *testing.T) {
	for _, c := range []struct{ account, computer, want string }{
		{`DESKTOP-C795OH4\User`, "DESKTOP-C795OH4", "user"},
		{`desktop-c795oh4\jun`, "DESKTOP-C795OH4", "jun"},
		{`CORP\jun`, "DESKTOP-C795OH4", ""},
		{`AzureAD\JunKim`, "DESKTOP-C795OH4", ""},
		{"jun", "DESKTOP-C795OH4", ""},
	} {
		if got := localAccountName(c.account, c.computer); got != c.want {
			t.Errorf("localAccountName(%q, %q) = %q, want %q", c.account, c.computer, got, c.want)
		}
	}
}
