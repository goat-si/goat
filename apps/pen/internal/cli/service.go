package cli

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

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

func render(tmpl string) (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if p, err := filepath.EvalSymlinks(exe); err == nil {
		exe = p
	}
	h, _ := os.UserHomeDir()
	out := strings.ReplaceAll(tmpl, "%h/.local/bin/pen", exe)
	out = strings.ReplaceAll(out, "__PEN__", exe)
	out = strings.ReplaceAll(out, "__HOME__", h)
	return out, nil
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
		unit, err := render(ServiceUnit)
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
		plist, err := render(LaunchdPlist)
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
