package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestSSHConfigTextNamesEveryMemberAndAFallback(t *testing.T) {
	got := sshConfigText(shellQuote("/bin/pen"), "/k/known_hosts", []string{"studio", "sbx"})
	block := func(host string) string {
		return "Host " + host + "\n    ProxyCommand '/bin/pen' pipe %n 22\n    UserKnownHostsFile \"/k/known_hosts\"\n    StrictHostKeyChecking yes\n"
	}
	want := "# Written by pen ssh-config. pen ssh-config --uninstall removes it.\n" + block("pen-studio") + block("pen-sbx") + block("pen-*")
	if got != want {
		t.Fatalf("config text:\n%s\nwant:\n%s", got, want)
	}
}

func TestSSHConfigInstallThenUninstallRestoresTheUserConfig(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PEN_SSH_DIR", dir)
	original := []byte("Host box\n    HostName 10.0.0.2\n")
	cfg := filepath.Join(dir, "config")
	if err := os.WriteFile(cfg, original, 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	if code := RunSSHConfig([]string{"--install"}, &out, &errOut); code != 0 {
		t.Fatalf("install exit %d: %s", code, errOut.String())
	}
	installed, _ := os.ReadFile(cfg)
	if !bytes.HasPrefix(installed, []byte("Include \""+filepath.Join(dir, "pen", "config")+"\"\n")) {
		t.Fatalf("Include is not the first line:\n%s", installed)
	}
	if code := RunSSHConfig([]string{"--install"}, &out, &errOut); code != 0 {
		t.Fatalf("second install exit %d", code)
	}
	if again, _ := os.ReadFile(cfg); !bytes.Equal(again, installed) {
		t.Fatalf("a second install changed the config:\n%s", again)
	}
	if code := RunSSHConfig([]string{"--uninstall"}, &out, &errOut); code != 0 {
		t.Fatalf("uninstall exit %d: %s", code, errOut.String())
	}
	restored, _ := os.ReadFile(cfg)
	if !bytes.Equal(restored, original) {
		t.Fatalf("uninstall left:\n%s", restored)
	}
	if _, err := os.Stat(filepath.Join(dir, "pen", "config")); !os.IsNotExist(err) {
		t.Fatalf("pen config still present: %v", err)
	}
}

func TestSSHConfigQuotesPathsWithSpacesQuotesAndPercent(t *testing.T) {
	got := sshConfigText(shellQuote("/Users/a b/it's/pen"), "/k 100%/known_hosts", nil)
	want := "# Written by pen ssh-config. pen ssh-config --uninstall removes it.\n" +
		"Host pen-*\n    ProxyCommand '/Users/a b/it'\\''s/pen' pipe %n 22\n    UserKnownHostsFile \"/k 100%%/known_hosts\"\n    StrictHostKeyChecking yes\n"
	if got != want {
		t.Fatalf("config text:\n%s\nwant:\n%s", got, want)
	}
}
