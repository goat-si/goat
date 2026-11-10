//go:build unix

package daemon

func defaultHostKeyGlob() string { return "/etc/ssh/ssh_host_*_key.pub" }

func loginName(account string) string { return account }
