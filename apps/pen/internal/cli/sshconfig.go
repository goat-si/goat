package cli

import (
	"bytes"
	"errors"

	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
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
		fmt.Fprintf(stdout, "removed %s and its Include line\n", filepath.Join(dir, "pen"))
		return 0
	}
	exe, err := os.Executable()
	if err != nil {
		return fail(stderr, err)
	}
	if p, err := filepath.EvalSymlinks(exe); err == nil {
		exe = p
	}
	cmd := exe
	if h := os.Getenv("PEN_HOME"); h != "" {
		cmd = "env PEN_HOME=" + h + " " + exe
	}
	var names []string
	if st, err := openState(); err == nil {
		if v, err := localView(st); err == nil {
			for _, m := range v.SortedMembers() {
				names = append(names, m.Name)
			}
		}
	}
	text := sshConfigText(cmd, knownHostsPath(), names)
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
		if err := installInclude(dir); err != nil {
			return fail(stderr, err)
		}
		fmt.Fprintf(stdout, "included it first in %s (backup %s)\n", filepath.Join(dir, "config"), filepath.Join(dir, "config.pen-backup"))
	} else {
		fmt.Fprintf(stdout, "add this as the first line of %s:\n%s\n", filepath.Join(dir, "config"), includeLine(dir))
	}
	return 0
}

// sshConfigText is one Host block per member name plus a pen-* fallback for names added later.
func sshConfigText(cmd, knownHosts string, names []string) string {
	var b strings.Builder
	b.WriteString("# Written by pen ssh-config. pen ssh-config --uninstall removes it.\n")
	block := func(pattern string) {
		fmt.Fprintf(&b, "Host %s\n", pattern)
		fmt.Fprintf(&b, "    ProxyCommand %s pipe %%n 22\n", cmd)
		fmt.Fprintf(&b, "    UserKnownHostsFile %s\n", knownHosts)
		b.WriteString("    StrictHostKeyChecking yes\n")
	}
	for _, n := range names {
		block("pen-" + n)
	}
	block("pen-*")
	return b.String()
}

func sshDir() string {
	if d := os.Getenv("PEN_SSH_DIR"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".ssh")
}

func includeLine(dir string) string { return "Include " + filepath.Join(dir, "pen", "config") }

func writeSSHConfig(dir, text string) (string, error) {
	if err := os.MkdirAll(filepath.Join(dir, "pen"), 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "pen", "config")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(text), 0o600); err != nil {
		return "", err
	}
	return path, os.Rename(tmp, path)
}

// installInclude puts the Include line first in <dir>/config, keeping a byte-for-byte backup.
func installInclude(dir string) error {
	cfg := filepath.Join(dir, "config")
	old, err := os.ReadFile(cfg)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	line := includeLine(dir)
	for _, l := range strings.Split(string(old), "\n") {
		if strings.TrimSpace(l) == line {
			return nil
		}
	}
	if err == nil {
		if err := os.WriteFile(cfg+".pen-backup", old, 0o600); err != nil {
			return err
		}
	}
	return os.WriteFile(cfg, append([]byte(line+"\n"), old...), 0o600)
}

// uninstallSSHConfig removes exactly the line installInclude added and the pen directory.
func uninstallSSHConfig(dir string) error {
	cfg := filepath.Join(dir, "config")
	old, err := os.ReadFile(cfg)
	if err == nil {
		prefix := []byte(includeLine(dir) + "\n")
		if bytes.HasPrefix(old, prefix) {
			if err := os.WriteFile(cfg, old[len(prefix):], 0o600); err != nil {
				return err
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.RemoveAll(filepath.Join(dir, "pen"))
}
