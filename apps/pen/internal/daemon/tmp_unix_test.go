//go:build unix

package daemon

// tmpRoot is a short temp root: $TMPDIR on macOS is too long for a control socket path.
func tmpRoot() string { return "/tmp" }
