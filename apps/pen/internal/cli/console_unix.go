//go:build unix

package cli

import "os/exec"

func detachConsole() {}

func hideWindow(*exec.Cmd) {}

// killChildrenWithMe is for the Windows supervisor only.
func killChildrenWithMe() error { return nil }
