//go:build unix

package cli

// proxyPrefix is the ProxyCommand through "pipe" for ssh's sh -c; a state directory other than the
// default travels in PEN_HOME.
func proxyPrefix(exe, home string) string {
	cmd := shellQuote(exe) + " pipe"
	if home != "" {
		cmd = "env PEN_HOME=" + shellQuote(home) + " " + cmd
	}
	return cmd
}

// The pen-* block's Host patterns and its ProxyCommand's node argument. ssh hands ProxyCommand to a
// shell with %n replaced by the host name as typed, and before OpenSSH 9.6 it accepts any name. In
// single quotes a name reaches pen as one word unless it holds a quote, and such a name matches
// the negated pattern, so the block does not apply to it.
const (
	fallbackHost = `pen-* "!*'*"`
	fallbackNode = "'%n'"
)

// connectionReuse: OpenSSH on unix has ControlMaster.
const connectionReuse = true

func configPath(p string) string { return p }
