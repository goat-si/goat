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

// connectionReuse: OpenSSH on unix has ControlMaster.
const connectionReuse = true

func configPath(p string) string { return p }
