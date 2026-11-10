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
		if exec.Command("systemctl", "--user", "show-environment").Run() == nil {
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
	if strings.ContainsAny(exe+home, "\x00\n\r") || !utf8.ValidString(exe+home) {
		return "", fmt.Errorf("cannot write a service for this path (a line break or bytes that are not UTF-8): %q", exe)
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

// systemdWord quotes one ExecStart word: inside double quotes a backslash and a quote are
// escaped, % starts a specifier (%%) and $ an environment variable ($$).
func systemdWord(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "%", "%%", "$", "$$").Replace(s) + `"`
}

func writeFile(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), 0o644)
}

// serviceOS and run are variables so tests can drive the service paths without a service manager.
var serviceOS = runtime.GOOS

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
