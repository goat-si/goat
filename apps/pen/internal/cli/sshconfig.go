package cli

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

// RunSSHConfig prints, writes or installs an ssh_config that reaches members as pen-<name>.
func RunSSHConfig(args []string, stdout, stderr io.Writer) int {
	fs := newFlags("ssh-config", stderr)
	write := fs.Bool("write", false, "write the config to <ssh dir>/pen/config")
	install := fs.Bool("install", false, "write it and include it first in ~/.ssh/config")
	uninstall := fs.Bool("uninstall", false, "remove the Include line and <ssh dir>/pen/")
	if _, err := parse(fs, args); err != nil {
		return 2
	}
	dir := sshDir()
	if *uninstall {
		if err := uninstallSSHConfig(dir); err != nil {
			return fail(stderr, err)
		}
		fmt.Fprintf(stdout, "removed %s and its Include line\n", filepath.Join(dir, "pen", "config"))
		return 0
	}
	cmd, err := pipeCommand()
	if err != nil {
		return fail(stderr, err)
	}
	var v *mesh.View
	if st, err := openState(); err == nil {
		v, _ = localView(st)
	}
	text := sshConfigText(cmd, knownHostsPath(), filepath.Join(dir, "pen"), hostsOf(v))
	if !*write && !*install {
		fmt.Fprint(stdout, text)
		return 0
	}
	path, err := writeSSHConfig(dir, text)
	if err != nil {
		return fail(stderr, err)
	}
	fmt.Fprintf(stdout, "wrote %s\n", path)
	if *install {
		backup, err := installInclude(dir)
		if err != nil {
			return fail(stderr, err)
		}
		fmt.Fprintf(stdout, "%s starts with %s\n", filepath.Join(dir, "config"), includeLine(dir))
		if backup != "" {
			fmt.Fprintf(stdout, "previous config kept in %s\n", backup)
		}
	} else {
		fmt.Fprintf(stdout, "add this as the first line of %s:\n%s\n", filepath.Join(dir, "config"), includeLine(dir))
	}
	return 0
}

// pipeCommand is the ProxyCommand up to and including "pipe" for this binary and state directory.
func pipeCommand() (string, error) {
	exe, err := exePath()
	if err != nil {
		return "", err
	}
	return proxyPrefix(exe, os.Getenv("PEN_HOME")), nil
}

func hostsOf(v *mesh.View) []sshHost {
	if v == nil {
		return nil
	}
	var hosts []sshHost
	for _, m := range v.SortedMembers() {
		hosts = append(hosts, sshHost{Name: m.Name, User: m.User, NodeID: m.NodeID, NoisePub: m.NoisePub})
	}
	return hosts
}

// refreshSSHConfig rewrites <ssh dir>/pen/config from a new view, but only once ssh-config --write or
// --install created it, so a joined machine sees its new peers (and their User) without another command.
func refreshSSHConfig(v *mesh.View) error {
	dir := sshDir()
	if _, err := os.Stat(filepath.Join(dir, "pen", "config")); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	cmd, err := pipeCommand()
	if err != nil {
		return err
	}
	_, err = writeSSHConfig(dir, sshConfigText(cmd, knownHostsPath(), filepath.Join(dir, "pen"), hostsOf(v)))
	return err
}

// shellQuote quotes s for the sh -c that runs ProxyCommand.
func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// sshArg double-quotes a path for ssh_config and keeps ssh from expanding % tokens in it.
func sshArg(s string) string { return `"` + strings.ReplaceAll(s, "%", "%%") + `"` }

// sshHost is one member's concrete Host block; User is empty when the member did not publish one.
// NodeID and NoisePub, when set, give the member an exact pen-<nodeId> block too.
type sshHost struct{ Name, User, NodeID, NoisePub string }

// controlSocketMax is the smallest sun_path (macOS, with its NUL); ssh binds the control socket
// first under its path plus a 17-byte ".<16 random>" suffix, and %C expands to 40 hex digits.
const controlSocketMax = 104

// sshConfigText is one Host block per member name plus a pen-* fallback for names added later.
// cmd is the quoted command through "pipe". Each host reuses one connection for 10 minutes
// (ControlMaster), so only the first ssh to a member pays the relay and key exchange round trips;
// control sockets live in controlDir, and are left out when their path would not fit a unix socket
// address (ssh -o ControlPath=none opens a fresh connection) or the ssh has no ControlMaster (Windows).
func sshConfigText(cmd, knownHosts, controlDir string, hosts []sshHost) string {
	var b strings.Builder
	b.WriteString("# Written by pen ssh-config. pen ssh-config --uninstall removes it.\n")
	controlPrefix := filepath.Join(controlDir, "cm-")
	reuse := connectionReuse && len(controlPrefix)+40+17 < controlSocketMax
	block := func(pattern, user string) {
		fmt.Fprintf(&b, "Host %s\n", pattern)
		if user != "" {
			fmt.Fprintf(&b, "    User %s\n", user)
		}
		fmt.Fprintf(&b, "    ProxyCommand %s %%n 22\n", strings.ReplaceAll(cmd, "%", "%%"))
		fmt.Fprintf(&b, "    UserKnownHostsFile %s\n", sshArg(configPath(knownHosts)))
		b.WriteString("    StrictHostKeyChecking yes\n")
		if !reuse {
			return
		}
		b.WriteString("    ControlMaster auto\n")
		fmt.Fprintf(&b, "    ControlPath %s\n", strings.TrimSuffix(sshArg(controlPrefix), `"`)+`%C"`)
		b.WriteString("    ControlPersist 10m\n")
	}
	// Exact blocks first: OpenSSH keeps the first value it reads, so pen-<nodeId> never takes the pen-*
	// block's ProxyCommand or its shared connection, which another route may have opened.
	ids := map[string]bool{}
	for _, h := range hosts {
		if h.NodeID == "" {
			continue
		}
		ids[h.NodeID] = true
		fmt.Fprintf(&b, "Host pen-%s\n", h.NodeID)
		if h.User != "" {
			fmt.Fprintf(&b, "    User %s\n", h.User)
		}
		fmt.Fprintf(&b, "    ProxyCommand %s --node %s --noise %s 22\n", strings.ReplaceAll(cmd, "%", "%%"), h.NodeID, h.NoisePub)
		fmt.Fprintf(&b, "    UserKnownHostsFile %s\n", sshArg(configPath(knownHosts)))
		b.WriteString("    StrictHostKeyChecking yes\n")
		if connectionReuse {
			b.WriteString("    ControlMaster no\n    ControlPath none\n")
		}
	}
	for _, h := range hosts {
		// A name that is a member's node id already means that node (pen pipe resolves ids first).
		if !ids[h.Name] {
			block("pen-"+h.Name, h.User)
		}
	}
	block("pen-*", "")
	return b.String()
}

func sshDir() string {
	if d := os.Getenv("PEN_SSH_DIR"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".ssh")
}

// includeLine quotes the path; Include takes no % tokens, so none are escaped.
func includeLine(dir string) string {
	return "Include \"" + configPath(filepath.Join(dir, "pen", "config")) + "\""
}

// ownInclude reports how many leading bytes of a config are pen's Include line: today's, or an older
// build's (unquoted, or with native Windows separators).
func ownInclude(dir string, cfg []byte) int {
	path := filepath.Join(dir, "pen", "config")
	for _, line := range []string{includeLine(dir), "Include \"" + path + "\"", "Include " + path} {
		if p := []byte(line + "\n"); bytes.HasPrefix(cfg, p) {
			return len(p)
		}
	}
	return 0
}

func writeSSHConfig(dir, text string) (string, error) {
	if err := os.MkdirAll(filepath.Join(dir, "pen"), 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "pen", "config")
	tmp, err := os.CreateTemp(filepath.Dir(path), ".config.tmp*")
	if err != nil {
		return "", err
	}
	_, err = tmp.WriteString(text)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = state.RestrictFile(tmp.Name())
	}
	if err == nil {
		err = state.Replace(tmp.Name(), path)
	}
	if err != nil {
		os.Remove(tmp.Name())
		return "", err
	}
	return path, nil
}

// installInclude puts the Include line first in <dir>/config (OpenSSH keeps the first value it reads),
// keeping a byte-for-byte backup of an existing file. It returns the backup path, if one was made.
func installInclude(dir string) (string, error) {
	cfg := filepath.Join(dir, "config")
	old, err := os.ReadFile(cfg)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if n := ownInclude(dir, old); n > 0 {
		if string(old[:n]) == includeLine(dir)+"\n" {
			return "", nil
		}
		old = old[n:]
	}
	prefix := []byte(includeLine(dir) + "\n")
	backup := ""
	if err == nil {
		backup = cfg + ".pen-backup"
		if err := os.WriteFile(backup, old, 0o600); err != nil {
			return "", err
		}
	}
	return backup, replaceFile(cfg, append(prefix, old...))
}

// replaceFile writes through a symlinked config (dotfile managers link it) by replacing the link's target.
func replaceFile(path string, data []byte) error {
	if target, err := filepath.EvalSymlinks(path); err == nil {
		path = target
	}
	tmp := path + ".pen-tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return state.Replace(tmp, path)
}

// uninstallSSHConfig removes exactly the line installInclude added and the config pen wrote. The daemon's
// known_hosts beside it stays; pen leave or pen down owns that.
func uninstallSSHConfig(dir string) error {
	cfg := filepath.Join(dir, "config")
	old, err := os.ReadFile(cfg)
	if err == nil {
		if n := ownInclude(dir, old); n > 0 {
			if err := replaceFile(cfg, old[n:]); err != nil {
				return err
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Remove(filepath.Join(dir, "pen", "config")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
