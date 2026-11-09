package cli

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// RunSSHConfig prints an ssh_config block that reaches members as pen-<name>.
func RunSSHConfig(args []string, stdout, stderr io.Writer) int {
	if _, err := parse(newFlags("ssh-config", stderr), args); err != nil {
		return 2
	}
	exe, err := os.Executable()
	if err != nil {
		return fail(stderr, err)
	}
	if p, err := filepath.EvalSymlinks(exe); err == nil {
		exe = p
	}
	cmd := exe
	if h := os.Getenv("PEN_HOME"); h != "" {
		cmd = "env PEN_HOME=" + h + " " + exe
	}
	fmt.Fprintf(stdout, "# pen: add to ~/.ssh/config, then: ssh pen-<name>\n")
	fmt.Fprintf(stdout, "Host pen-*\n")
	fmt.Fprintf(stdout, "    ProxyCommand %s pipe %%n 22\n", cmd)
	fmt.Fprintf(stdout, "    UserKnownHostsFile %s\n", knownHostsPath())
	fmt.Fprintf(stdout, "    StrictHostKeyChecking yes\n")
	return 0
}

