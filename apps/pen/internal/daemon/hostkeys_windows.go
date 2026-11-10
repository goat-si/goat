package daemon

import (
	"os"
	"path/filepath"
)

// defaultHostKeyGlob finds the keys of Windows's OpenSSH Server under %ProgramData%\ssh.
func defaultHostKeyGlob() string {
	dir := os.Getenv("ProgramData")
	if dir == "" {
		dir = `C:\ProgramData`
	}
	return filepath.Join(dir, "ssh", "ssh_host_*_key.pub")
}
