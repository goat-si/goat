//go:build unix

package cli

import (
	"strings"
	"testing"
)

// ctl is the connection reuse every pen host gets, with its control sockets under /k.
const ctl = "    ControlMaster auto\n    ControlPath \"/k/cm-%C\"\n    ControlPersist 10m\n"

func TestSSHConfigTextNamesEveryMemberAndAFallback(t *testing.T) {
	got := sshConfigText(shellQuote("/bin/pen")+" pipe", "/k/known_hosts", "/k", []sshHost{{Name: "studio"}, {Name: "sbx"}})
	block := func(host string) string {
		return "Host " + host + "\n    ProxyCommand '/bin/pen' pipe %n 22\n    UserKnownHostsFile \"/k/known_hosts\"\n    StrictHostKeyChecking yes\n" + ctl
	}
	want := "# Written by pen ssh-config. pen ssh-config --uninstall removes it.\n" + block("pen-studio") + block("pen-sbx") + block("pen-*")
	if got != want {
		t.Fatalf("config text:\n%s\nwant:\n%s", got, want)
	}
}

func TestSSHConfigTextSetsUserOnHostsThatPublishedOne(t *testing.T) {
	got := sshConfigText(shellQuote("/bin/pen")+" pipe", "/k/known_hosts", "/k", []sshHost{{Name: "sbx", User: "ubuntu"}, {Name: "studio"}})
	want := "# Written by pen ssh-config. pen ssh-config --uninstall removes it.\n" +
		"Host pen-sbx\n    User ubuntu\n    ProxyCommand '/bin/pen' pipe %n 22\n    UserKnownHostsFile \"/k/known_hosts\"\n    StrictHostKeyChecking yes\n" + ctl +
		"Host pen-studio\n    ProxyCommand '/bin/pen' pipe %n 22\n    UserKnownHostsFile \"/k/known_hosts\"\n    StrictHostKeyChecking yes\n" + ctl +
		"Host pen-*\n    ProxyCommand '/bin/pen' pipe %n 22\n    UserKnownHostsFile \"/k/known_hosts\"\n    StrictHostKeyChecking yes\n" + ctl
	if got != want {
		t.Fatalf("config text:\n%s\nwant:\n%s", got, want)
	}
}

func TestSSHConfigQuotesPathsWithSpacesQuotesAndPercent(t *testing.T) {
	got := sshConfigText(shellQuote("/Users/a b/it's/pen")+" pipe", "/k 100%/known_hosts", "/k 100%", nil)
	want := "# Written by pen ssh-config. pen ssh-config --uninstall removes it.\n" +
		"Host pen-*\n    ProxyCommand '/Users/a b/it'\\''s/pen' pipe %n 22\n    UserKnownHostsFile \"/k 100%%/known_hosts\"\n    StrictHostKeyChecking yes\n" +
		"    ControlMaster auto\n    ControlPath \"/k 100%%/cm-%C\"\n    ControlPersist 10m\n"
	if got != want {
		t.Fatalf("config text:\n%s\nwant:\n%s", got, want)
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
