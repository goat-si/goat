package daemon

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// defaultHostKeyGlob finds the keys of Windows's OpenSSH Server under %ProgramData%\ssh.
func defaultHostKeyGlob() string {
	dir := os.Getenv("ProgramData")
	if dir == "" {
		dir = `C:\ProgramData`
	}
	return filepath.Join(dir, "ssh", "ssh_host_*_key.pub")
}

// loginName maps COMPUTER\name to name for a local account (the NetBIOS computer name is the domain
// part Windows gives local accounts).
func loginName(account string) string {
	computer, err := windows.ComputerName()
	if err != nil {
		return ""
	}
	return localAccountName(account, computer)
}
