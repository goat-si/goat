//go:build unix && !darwin

package cli

import (
	"os"
	"os/exec"
)

func openInBrowser(path string) error {
	if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
		return errNoDesktop
	}
	return exec.Command("xdg-open", path).Run()
}
