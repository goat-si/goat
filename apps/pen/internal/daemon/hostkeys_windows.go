package daemon

import (
	"os"
	"path/filepath"
	"strings"

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

// hostKeysFix grants Authenticated Users (S-1-5-11) read access to the public keys only.
func hostKeysFix(glob string) string {
	return "in an administrator PowerShell run icacls " + psQuote(glob) + " /grant '*S-1-5-11:(R)', then pen down and pen up, or wait up to an hour"
}

// hostKeysDirFix grants list and traverse on the folder itself; without (OI)(CI) nothing inherits it,
// so the private keys keep their own ACLs.
func hostKeysDirFix(dir string) string {
	return "in an administrator PowerShell run icacls " + psQuote(dir) + " /grant '*S-1-5-11:(RX)', then pen down and pen up, or wait up to an hour"
}

// psQuote is a PowerShell single-quoted string, in which a doubled single quote stands for one.
func psQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// loginName maps COMPUTER\name to name for a local account (the NetBIOS computer name is the domain
// part Windows gives local accounts).
func loginName(account string) string {
	computer, err := windows.ComputerName()
	if err != nil {
		return ""
	}
	return localAccountName(account, computer)
}
