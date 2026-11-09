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
	switch runtime.GOOS {
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
	if _, err := os.Stat(unitPath()); err == nil && runtime.GOOS == "linux" {
		return "systemd"
	}
	if _, err := os.Stat(plistPath()); err == nil && runtime.GOOS == "darwin" {
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

func run(name string, args ...string) error {
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
		exec.Command("launchctl", "bootout", guiDomain()+"/"+launchdLabel).Run()
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

// detachService disables the service and deletes its file without stopping the running daemon.
func detachService(mode string) error {
	switch mode {
	case "systemd":
		if err := run("systemctl", "--user", "disable", "pen.service"); err != nil {
			return err
		}
		if err := os.Remove(unitPath()); err != nil && !os.IsNotExist(err) {
			return err
		}
		return run("systemctl", "--user", "daemon-reload")
	case "launchd":
		if err := run("launchctl", "disable", guiDomain()+"/"+launchdLabel); err != nil {
			return err
		}
		if err := os.Remove(plistPath()); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

// unloadLaunchd drops the (already exited) launchd job after leave.
func unloadLaunchd() { exec.Command("launchctl", "bootout", guiDomain()+"/"+launchdLabel).Run() }
