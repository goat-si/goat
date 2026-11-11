//go:build unix

package daemon

func defaultHostKeyGlob() string { return "/etc/ssh/ssh_host_*_key.pub" }

func hostKeysFix(glob string) string {
	return "make them readable (sudo chmod 644 " + glob + "), then run pen down and pen up, or wait up to an hour"
}

func loginName(account string) string { return account }
