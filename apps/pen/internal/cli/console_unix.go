//go:build unix

package cli

import "os/exec"

func detachConsole() {}

func hideWindow(*exec.Cmd) {}
