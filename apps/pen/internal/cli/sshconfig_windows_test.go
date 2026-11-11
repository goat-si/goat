package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// Win32-OpenSSH starts ProxyCommand without a shell and has no ControlMaster; ssh_config paths use
// forward slashes so its argument splitting cannot read a backslash as an escape.
func TestSSHConfigOnWindowsQuotesForCreateProcessAndPassesTheHomeAsAFlag(t *testing.T) {
	cmd := proxyPrefix(`C:\Users\a b\pen.exe`, `C:\Users\a b\100%\.pen`)
	got := sshConfigText(cmd, `C:\Users\a b\.ssh\pen\known_hosts`, `C:\Users\a b\.ssh\pen`, []sshHost{{Name: "studio", User: "jun"}})
	block := func(host, user string) string {
		return "Host " + host + "\n" + user +
			"    ProxyCommand \"C:\\Users\\a b\\pen.exe\" pipe --home \"C:\\Users\\a b\\100%%\\.pen\" %n 22\n" +
			"    UserKnownHostsFile \"C:/Users/a b/.ssh/pen/known_hosts\"\n    StrictHostKeyChecking yes\n"
	}
	want := "# Written by pen ssh-config. pen ssh-config --uninstall removes it.\n" + block("pen-studio", "    User jun\n") + block("pen-*", "")
	if got != want {
		t.Fatalf("config text:\n%s\nwant:\n%s", got, want)
	}
}

func TestQuoteArgFollowsCommandLineToArgvW(t *testing.T) {
	for in, want := range map[string]string{
		`C:\pen.exe`:     `"C:\pen.exe"`,
		`C:\`:            `"C:\\"`,
		`C:\a b\`:        `"C:\a b\\"`,
		`a"b`:            `"a\"b"`,
		`a\"b`:           `"a\\\"b"`,
		`\\server\share`: `"\\server\share"`,
	} {
		if got := quoteArg(in); got != want {
			t.Errorf("quoteArg(%s) = %s, want %s", in, got, want)
		}
	}
}

// An Include an older build wrote with native separators is replaced, not kept beside the new one.
func TestSSHConfigInstallOnWindowsReplacesANativePathInclude(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PEN_SSH_DIR", dir)
	cfg := filepath.Join(dir, "config")
	rest := "Host box\n    HostName 10.0.0.2\n"
	if err := os.WriteFile(cfg, []byte("Include \""+filepath.Join(dir, "pen", "config")+"\"\n"+rest), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	if code := RunSSHConfig([]string{"--install"}, &out, &errOut); code != 0 {
		t.Fatalf("install exit %d: %s", code, errOut.String())
	}
	got, _ := os.ReadFile(cfg)
	if want := includeLine(dir) + "\n" + rest; string(got) != want {
		t.Fatalf("config:\n%s\nwant:\n%s", got, want)
	}
}
