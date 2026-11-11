package cli

import (
	"encoding/xml"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/goat-si/goat/apps/pen/internal/state"
)

const launchdLabel = "si.goat.pen"

// serviceMode picks systemd --user, launchd or none (a detached child). A non-default state
// directory never gets a service, so test and scratch homes cannot replace the real one.
func serviceMode(noService bool, st *state.Store) string {
	if noService || os.Getenv("PEN_SERVICE") == "none" || os.Getenv("PEN_HOME") != "" {
		return "none"
	}
	switch serviceOS {
	case "linux":
		withUserBus()
		if run("systemctl", "--user", "show-environment") == nil {
			return "systemd"
		}
	case "darwin":
		if _, err := exec.LookPath("launchctl"); err == nil {
			return "launchd"
		}
	}
	return "none"
}

func unitPath() string {
	h, _ := os.UserHomeDir()
	return filepath.Join(h, ".config", "systemd", "user", "pen.service")
}

func plistPath() string {
	h, _ := os.UserHomeDir()
	return filepath.Join(h, "Library", "LaunchAgents", launchdLabel+".plist")
}

// installedService reports the service pen up installed, if any.
func installedService(st *state.Store) string {
	if os.Getenv("PEN_HOME") != "" {
		return "none"
	}
	if _, err := os.Stat(unitPath()); err == nil && serviceOS == "linux" {
		return "systemd"
	}
	if _, err := os.Stat(plistPath()); err == nil && serviceOS == "darwin" {
		return "launchd"
	}
	return "none"
}

// render fills a service template with this executable's path and the home folder, escaped for
// the file it goes into: XML text in the launchd plist, systemd's quoted word in the unit.
func render(tmpl string, plist bool) (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if p, err := filepath.EvalSymlinks(exe); err == nil {
		exe = p
	}
	h, _ := os.UserHomeDir()
	return fill(tmpl, plist, exe, h)
}

func fill(tmpl string, plist bool, exe, home string) (string, error) {
	bad := !utf8.ValidString(exe+home) || strings.ContainsFunc(exe+home, func(r rune) bool { return r < 0x20 || r == 0x7f })
	// systemd expands $ only in arguments: the executable path keeps $$ and is not found.
	if !plist && strings.Contains(exe, "$") {
		bad = true
	}
	if bad {
		return "", fmt.Errorf("cannot write a service that starts %q exactly (control characters, bytes that are not UTF-8, or $ in a systemd unit); install pen under a path without them", exe)
	}
	if plist {
		return strings.NewReplacer("__PEN__", xmlText(exe), "__HOME__", xmlText(home)).Replace(tmpl), nil
	}
	return strings.ReplaceAll(tmpl, "%h/.local/bin/pen", systemdWord(exe)), nil
}

func xmlText(s string) string {
	var b strings.Builder
	xml.EscapeText(&b, []byte(s))
	return b.String()
}

// systemdWord quotes the ExecStart executable (systemd.service(5), "Command lines"): double quotes
// keep spaces in one word, and C-style escapes inside them give a literal backslash (\\) and quote
// (\"); systemd.unit(5), "Specifiers": %% is a literal %. A $ cannot be carried (fill refuses it).
func systemdWord(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "%", "%%").Replace(s) + `"`
}

func writeFile(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), 0o644)
}

// serviceOS and run are variables so tests can drive the service paths without a service manager.
var serviceOS = runtime.GOOS

// userRuntimeRoot is a variable so tests can stand in for /run/user.
var userRuntimeRoot = "/run/user"

// withUserBus points systemctl --user at this user's manager when the session does not say where
// it is: a cloud console's command runner (dvb exec, cloud-init) has no XDG_RUNTIME_DIR, though
// with linger the manager runs.
func withUserBus() {
	if os.Getenv("XDG_RUNTIME_DIR") != "" {
		return
	}
	dir := filepath.Join(userRuntimeRoot, strconv.Itoa(os.Getuid()))
	if _, err := os.Stat(filepath.Join(dir, "bus")); err == nil {
		os.Setenv("XDG_RUNTIME_DIR", dir)
	}
}

var run = func(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func guiDomain() string { return "gui/" + strconv.Itoa(os.Getuid()) }

func startService(mode string, st *state.Store) error {
	switch mode {
	case "systemd":
		unit, err := render(ServiceUnit, false)
		if err != nil {
			return err
		}
		if err := writeFile(unitPath(), unit); err != nil {
			return err
		}
		if err := run("systemctl", "--user", "daemon-reload"); err != nil {
			return err
		}
		if err := run("systemctl", "--user", "enable", "--now", "pen.service"); err != nil {
			return err
		}
	case "launchd":
		plist, err := render(LaunchdPlist, true)
		if err != nil {
			return err
		}
		if err := writeFile(plistPath(), plist); err != nil {
			return err
		}
		run("launchctl", "bootout", guiDomain()+"/"+launchdLabel)
		// pen leave disables the job; starting again re-enables it.
		if err := run("launchctl", "enable", guiDomain()+"/"+launchdLabel); err != nil {
			return err
		}
		if err := run("launchctl", "bootstrap", guiDomain(), plistPath()); err != nil {
			return err
		}
	}
	return waitControl(st)
}

func stopService(mode string) error {
	switch mode {
	case "systemd":
		withUserBus()
		return run("systemctl", "--user", "stop", "pen.service")
	case "launchd":
		return run("launchctl", "bootout", guiDomain()+"/"+launchdLabel)
	}
	return nil
}

// removeService stops and disables the service, then deletes its file. disable --now stops a unit
// that an older install loaded with Restart=always, so it cannot loop on the left marker.
func removeService(mode string) error {
	switch mode {
	case "systemd":
		withUserBus()
		run("systemctl", "--user", "disable", "--now", "pen.service") // absent or already stopped is fine
		if err := os.Remove(unitPath()); err != nil && !os.IsNotExist(err) {
			return err
		}
		return run("systemctl", "--user", "daemon-reload")
	case "launchd":
		run("launchctl", "bootout", guiDomain()+"/"+launchdLabel) // the job may already be gone
		if err := os.Remove(plistPath()); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}
