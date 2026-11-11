package cli

import "os/exec"

func openInBrowser(path string) error { return exec.Command("open", path).Run() }
