package cli

import (
	"errors"
	"strings"
	"testing"
)

func fakeStartNote(t *testing.T, osName string, managerFound bool, linger string) {
	t.Helper()
	oldOS, oldFound, oldOut, oldExe := serviceOS, serviceManagerFound, output, exePath
	t.Cleanup(func() { serviceOS, serviceManagerFound, output, exePath = oldOS, oldFound, oldOut, oldExe })
	t.Setenv("PEN_HOME", "")
	t.Setenv("PEN_SERVICE", "")
	serviceOS = osName
	serviceManagerFound = func(string) bool { return managerFound }
	exePath = func() (string, error) { return "/root/.local/bin/pen", nil }
	output = func(name string, args ...string) (string, error) {
		if name != "loginctl" {
			t.Fatalf("unexpected command %s %v", name, args)
		}
		if linger == "" {
			return "", errors.New("no logind")
		}
		return linger + "\n", nil
	}
}

// P2: on Linux with no service manager answering, Pen runs detached and nothing restarts it; pen up
// says so and gives the startup line. A person who chose --no-service is not told again.
func TestUpWithoutAServiceManagerSaysNothingRestartsPenAndPrintsTheStartupLine(t *testing.T) {
	fakeStartNote(t, "linux", false, "")
	note := startNote(serviceMode(false, nil), false)
	if !strings.Contains(note, "nothing starts Pen again") || !strings.Contains(note, "'/root/.local/bin/pen' up") {
		t.Fatalf("pen up without a service manager printed %q", note)
	}
	if note := startNote(serviceMode(true, nil), true); note != "" {
		t.Fatalf("pen up --no-service printed %q", note)
	}
	t.Setenv("PEN_HOME", "/tmp/scratch")
	if note := startNote(serviceMode(false, nil), false); note != "" {
		t.Fatalf("pen up with PEN_HOME printed %q", note)
	}
}

// P3: with lingering off, systemd stops Pen's user service when the user's last session ends; pen up
// prints the line that keeps it running. Lingering on, or no logind to ask, prints nothing.
func TestUpUnderSystemdWithLingerOffPrintsTheEnableLingerLine(t *testing.T) {
	fakeStartNote(t, "linux", true, "no")
	t.Setenv("USER", "jun")
	if note := startNote("systemd", false); !strings.Contains(note, "sudo loginctl enable-linger jun") {
		t.Fatalf("pen up under systemd with Linger=no printed %q", note)
	}
	fakeStartNote(t, "linux", true, "yes")
	if note := startNote("systemd", false); note != "" {
		t.Fatalf("pen up with Linger=yes printed %q", note)
	}
	fakeStartNote(t, "linux", true, "")
	if note := startNote("systemd", false); note != "" {
		t.Fatalf("pen up without logind printed %q", note)
	}
}
