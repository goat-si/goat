package cli

import (
	"context"
	"encoding/xml"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/goat-si/goat/apps/pen/internal/state"
)

const launchdLabel = "si.goat.pen"

// serviceMode picks systemd --user, launchd, a Windows logon task or none (a detached child). A
// non-default state directory never gets a service, so test and scratch homes cannot replace the real one.
func serviceMode(noService bool, st *state.Store) string {
	if serviceOptedOut(noService) {
		return "none"
	}
	switch serviceOS {
	case "linux":
		if serviceManagerFound("systemd") {
			return "systemd"
		}
	case "darwin":
		if serviceManagerFound("launchd") {
			return "launchd"
		}
	case "windows":
		return "task" // schtasks.exe ships with every Windows 10 and 11
	}
	return "none"
}

func serviceOptedOut(noService bool) bool {
	return noService || os.Getenv("PEN_SERVICE") == "none" || os.Getenv("PEN_HOME") != ""
}

// startNote is what pen up adds after a start that will not survive on its own: no service manager
// answered, or systemd stops the user's services at logout because lingering is off.
func startNote(mode string, noService bool) string {
	switch {
	case mode == "none" && !serviceOptedOut(noService) && serviceOS != "windows":
		exe, err := exePath()
		if err != nil {
			exe = "pen"
		}
		manager := map[string]string{"linux": "systemctl --user", "darwin": "launchctl"}[serviceOS]
		if manager == "" {
			manager = "none supported on " + serviceOS
		}
		// Another account's startup script (root's) would start another node from its own home.
		return "pen: no service manager answered (" + manager + "), so nothing starts Pen again if it stops or this machine restarts. Run " +
			shellQuote(exe) + " up at startup as " + loginUserName() + ", with that account's HOME, for example with the line @reboot " + shellQuote(exe) + " up in its crontab -e"
	case mode == "systemd":
		linger, err := output("loginctl", "show-user", strconv.Itoa(os.Getuid()), "--property=Linger", "--value")
		if err != nil || strings.TrimSpace(linger) != "no" {
			return "" // unknown without logind: say nothing rather than guess
		}
		return "pen: lingering is off, so systemd stops Pen when your last session on this machine ends. Keep it running with: sudo loginctl enable-linger " + loginUserName()
	}
	return ""
}

// loginUserName names this process's uid, never $USER, which su or sudo can leave pointing elsewhere.
func loginUserName() string {
	if u, err := user.Current(); err == nil && u.Username != "" {
		return u.Username
	}
	return strconv.Itoa(os.Getuid())
}

// serviceManagerFound reports whether systemd --user or launchctl answers here (a variable for tests).
var serviceManagerFound = func(mode string) bool {
	if mode == "systemd" {
		return exec.Command("systemctl", "--user", "show-environment").Run() == nil
	}
	_, err := exec.LookPath("launchctl")
	return err == nil
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
	if serviceOS == "windows" {
		if name, err := accountTaskName(); err == nil && run("schtasks", "/Query", "/TN", name) == nil {
			return "task"
		}
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

// exePath is this binary, symlinks resolved (a variable so tests can give another path).
var exePath = func() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if p, err := filepath.EvalSymlinks(exe); err == nil {
		exe = p
	}
	return exe, nil
}

// render fills a service template with this executable's path and the home folder, escaped for
// the file it goes into: XML text in the launchd plist, systemd's quoted word in the unit.
func render(tmpl string, plist bool) (string, error) {
	exe, err := exePath()
	if err != nil {
		return "", err
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

// run runs a service manager command, ended (by its own process) after commandTimeout.
var run = func(name string, args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.WaitDelay = time.Second
	out, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return fmt.Errorf("%s %s: no answer within %v", name, strings.Join(args, " "), commandTimeout)
	}
	if err != nil {
		return fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// output is run for a command whose answer pen reads.
var output = func(name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).Output()
	return string(out), err
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
	case "task":
		if err := startTaskInTurn(st); err != nil { // pen up holds the task turn
			return err
		}
	}
	return waitControl(st)
}

func stopService(mode string, st *state.Store) error {
	switch mode {
	case "systemd":
		return run("systemctl", "--user", "stop", "pen.service")
	case "launchd":
		return run("launchctl", "bootout", guiDomain()+"/"+launchdLabel)
	case "task":
		return stopTaskInTurn(st) // pen down holds the task turn
	}
	return nil
}

// removeService stops and disables the service, then deletes its file. disable --now stops a unit
// that an older install loaded with Restart=always, so it cannot loop on the left marker.
func removeService(mode string, st *state.Store) error {
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
	case "task":
		return removeTaskInTurn(st) // pen leave holds the task turn
	}
	return nil
}
