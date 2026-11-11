//go:build unix

package cli

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// ctl is the connection reuse every pen host gets, with its control sockets under /k.
const ctl = "    ControlMaster auto\n    ControlPath \"/k/cm-%C\"\n    ControlPersist 10m\n"

// fallback is the pen-* block for /bin/pen: the only block that quotes the name it is given.
const fallback = "Host pen-* \"!*'*\"\n    ProxyCommand '/bin/pen' pipe '%n' 22\n    UserKnownHostsFile \"/k/known_hosts\"\n    StrictHostKeyChecking yes\n" + ctl

func TestSSHConfigTextNamesEveryMemberAndAFallback(t *testing.T) {
	got := sshConfigText(shellQuote("/bin/pen")+" pipe", "/k/known_hosts", "/k", []sshHost{{Name: "studio"}, {Name: "sbx"}})
	block := func(host string) string {
		return "Host " + host + "\n    ProxyCommand '/bin/pen' pipe %n 22\n    UserKnownHostsFile \"/k/known_hosts\"\n    StrictHostKeyChecking yes\n" + ctl
	}
	want := "# Written by pen ssh-config. pen ssh-config --uninstall removes it.\n" + block("pen-studio") + block("pen-sbx") + fallback
	if got != want {
		t.Fatalf("config text:\n%s\nwant:\n%s", got, want)
	}
}

func TestSSHConfigTextSetsUserOnHostsThatPublishedOne(t *testing.T) {
	got := sshConfigText(shellQuote("/bin/pen")+" pipe", "/k/known_hosts", "/k", []sshHost{{Name: "sbx", User: "ubuntu"}, {Name: "studio"}})
	want := "# Written by pen ssh-config. pen ssh-config --uninstall removes it.\n" +
		"Host pen-sbx\n    User ubuntu\n    ProxyCommand '/bin/pen' pipe %n 22\n    UserKnownHostsFile \"/k/known_hosts\"\n    StrictHostKeyChecking yes\n" + ctl +
		"Host pen-studio\n    ProxyCommand '/bin/pen' pipe %n 22\n    UserKnownHostsFile \"/k/known_hosts\"\n    StrictHostKeyChecking yes\n" + ctl +
		fallback
	if got != want {
		t.Fatalf("config text:\n%s\nwant:\n%s", got, want)
	}
}

func TestSSHConfigQuotesPathsWithSpacesQuotesAndPercent(t *testing.T) {
	got := sshConfigText(shellQuote("/Users/a b/it's/pen")+" pipe", "/k 100%/known_hosts", "/k 100%", nil)
	want := "# Written by pen ssh-config. pen ssh-config --uninstall removes it.\n" +
		"Host pen-* \"!*'*\"\n    ProxyCommand '/Users/a b/it'\\''s/pen' pipe '%n' 22\n    UserKnownHostsFile \"/k 100%%/known_hosts\"\n    StrictHostKeyChecking yes\n" +
		"    ControlMaster auto\n    ControlPath \"/k 100%%/cm-%C\"\n    ControlPersist 10m\n"
	if got != want {
		t.Fatalf("config text:\n%s\nwant:\n%s", got, want)
	}
}

// ssh before 9.6 takes any host name, replaces %n with it and hands ProxyCommand to a shell as
// "exec <command>". A name the fallback matches (none holds a quote) must reach pen as one word.
func TestTheFallbacksProxyCommandGivesTheShellNothingToRunFromATypedHostName(t *testing.T) {
	dir := t.TempDir()
	pen, log, marker := filepath.Join(dir, "pen"), filepath.Join(dir, "args"), filepath.Join(dir, "ran")
	script := "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done > '" + log + "'\n"
	if err := os.WriteFile(pen, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	text := sshConfigText(shellQuote(pen)+" pipe", "/k/known_hosts", "/k", nil)
	_, command, ok := strings.Cut(text, "    ProxyCommand ")
	if !ok {
		t.Fatalf("no ProxyCommand in:\n%s", text)
	}
	command, _, _ = strings.Cut(command, "\n")
	for _, name := range []string{
		"pen-x$(touch " + marker + ")",
		"pen-x`touch " + marker + "`",
		"pen-x;touch " + marker + ";",
		"pen-x && touch " + marker,
		"pen-x | touch " + marker,
	} {
		os.Remove(log)
		exec.Command("sh", "-c", "exec "+strings.ReplaceAll(command, "%n", name)).Run()
		if _, err := os.Stat(marker); err == nil {
			t.Fatalf("the host name %q ran a command through the fallback's ProxyCommand", name)
		}
		got, _ := os.ReadFile(log)
		if want := "pipe\n" + name + "\n22\n"; string(got) != want {
			t.Fatalf("pen got %q for the host name %q, want %q", got, name, want)
		}
	}
}

func TestSSHConfigLeavesOutConnectionReuseWhenTheControlSocketPathWouldNotFit(t *testing.T) {
	long := "/" + strings.Repeat("d", 50)
	got := sshConfigText(shellQuote("/bin/pen")+" pipe", "/k/known_hosts", long, []sshHost{{Name: "studio"}})
	if strings.Contains(got, "Control") {
		t.Fatalf("control dir %s gives sockets over 104 bytes, yet the config sets:\n%s", long, got)
	}
	if !strings.Contains(got, "ProxyCommand") {
		t.Fatalf("config lost its ProxyCommand:\n%s", got)
	}
}
