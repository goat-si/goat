package cli

import (
	"os/exec"

	"golang.org/x/sys/windows"
)

// openInBrowser hands the file to the default browser. Session 0 (a service, or ssh into the machine)
// has no desktop to show it on.
func openInBrowser(path string) error {
	var session uint32
	if windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &session) == nil && session == 0 {
		return errNoDesktop
	}
	return exec.Command("rundll32", "url.dll,FileProtocolHandler", path).Run()
}
