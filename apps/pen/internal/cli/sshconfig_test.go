package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/mesh"
)

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
	if !bytes.HasPrefix(installed, []byte(includeLine(dir)+"\n")) {
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

func TestSSHConfigInstallKeepsASymlinkedConfigAndUninstallKeepsKnownHosts(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PEN_SSH_DIR", dir)
	real := filepath.Join(dir, "dotfiles-config")
	original := []byte("Host box\n")
	if err := os.WriteFile(real, original, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(dir, "config")
	if err := os.Symlink(real, cfg); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "pen"), 0o700); err != nil {
		t.Fatal(err)
	}
	known := filepath.Join(dir, "pen", "known_hosts")
	if err := os.WriteFile(known, []byte("pen-x ssh-ed25519 AAAA\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	if code := RunSSHConfig([]string{"--install"}, &out, &errOut); code != 0 {
		t.Fatalf("install exit %d: %s", code, errOut.String())
	}
	if fi, err := os.Lstat(cfg); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("install replaced the symlink: %v", err)
	}
	if got, _ := os.ReadFile(real); !bytes.HasPrefix(got, []byte(includeLine(dir)+"\n")) {
		t.Fatalf("the link target did not get the Include:\n%s", got)
	}
	if code := RunSSHConfig([]string{"--uninstall"}, &out, &errOut); code != 0 {
		t.Fatalf("uninstall exit %d: %s", code, errOut.String())
	}
	if got, _ := os.ReadFile(real); !bytes.Equal(got, original) {
		t.Fatalf("uninstall left:\n%s", got)
	}
	if _, err := os.Stat(known); err != nil {
		t.Fatalf("uninstall removed the daemon's known_hosts: %v", err)
	}
}

func TestSSHConfigInstallReplacesAnOlderUnquotedIncludeInsteadOfAddingASecond(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PEN_SSH_DIR", dir)
	cfg := filepath.Join(dir, "config")
	rest := "Host box\n"
	if err := os.WriteFile(cfg, []byte("Include "+filepath.Join(dir, "pen", "config")+"\n"+rest), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	if code := RunSSHConfig([]string{"--install"}, &out, &errOut); code != 0 {
		t.Fatalf("install exit %d: %s", code, errOut.String())
	}
	if got, _ := os.ReadFile(cfg); string(got) != includeLine(dir)+"\n"+rest {
		t.Fatalf("config:\n%s", got)
	}
}

func TestRefreshSSHConfigRewritesAnInstalledConfigWithEveryMemberAndLeavesAMissingOneAlone(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PEN_SSH_DIR", dir)
	v := &mesh.View{Members: map[string]mesh.Member{
		"k1": {Name: "studio", NodeID: "aaaa"},
		"k2": {Name: "sbx1", NodeID: "bbbb", User: "ubuntu"},
	}}
	refreshSSHConfig(v)
	if _, err := os.Stat(filepath.Join(dir, "pen", "config")); !os.IsNotExist(err) {
		t.Fatalf("refresh created a config nobody asked for: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "pen"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "pen", "config"), []byte("# old\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	refreshSSHConfig(v)
	got, _ := os.ReadFile(filepath.Join(dir, "pen", "config"))
	if !bytes.Contains(got, []byte("Host pen-sbx1\n    User ubuntu\n")) || !bytes.Contains(got, []byte("Host pen-studio\n")) {
		t.Fatalf("refreshed config:\n%s", got)
	}
}
