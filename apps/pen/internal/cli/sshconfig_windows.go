package cli

import (
	"path/filepath"
	"strings"
)

// proxyPrefix is the ProxyCommand through "pipe" for Win32-OpenSSH, which starts it with CreateProcessW
// and no shell: each argument is quoted by the CommandLineToArgvW rules, and a state directory other
// than the default travels as pipe --home (there is no env to set it).
func proxyPrefix(exe, home string) string {
	cmd := quoteArg(exe) + " pipe"
	if home != "" {
		cmd += " --home " + quoteArg(home)
	}
	return cmd
}

// quoteArg double-quotes s for CommandLineToArgvW: backslashes before a quote, and before the closing
// one, are doubled.
func quoteArg(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	slashes := 0
	for _, c := range s {
		switch c {
		case '\\':
			slashes++
			continue
		case '"':
			b.WriteString(strings.Repeat(`\`, 2*slashes+1))
		default:
			b.WriteString(strings.Repeat(`\`, slashes))
		}
		slashes = 0
		b.WriteRune(c)
	}
	b.WriteString(strings.Repeat(`\`, 2*slashes))
	b.WriteByte('"')
	return b.String()
}

// The pen-* block's Host pattern and its ProxyCommand's node argument. No shell reads the command
// here, and pen pipe reads no flag after the node, so a typed name needs no quoting.
const (
	fallbackHost = "pen-*"
	fallbackNode = "%n"
)

// connectionReuse: Win32-OpenSSH has no ControlMaster.
const connectionReuse = false

// configPath writes forward slashes: ssh_config's argument splitting treats a backslash before a quote,
// a space or another backslash as an escape.
func configPath(p string) string { return filepath.ToSlash(p) }
