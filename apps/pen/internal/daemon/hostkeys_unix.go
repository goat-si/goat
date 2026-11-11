//go:build unix

package daemon

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func defaultHostKeyGlob() string { return "/etc/ssh/ssh_host_*_key.pub" }

func hostKeysFix(glob string) string {
	return "make them readable (sudo chmod a+r " + shellQuote(filepath.Dir(glob)) + "/" + filepath.Base(glob) + "), then run pen down and pen up, or wait up to an hour"
}

// hostKeysDirFix names the access Pen needs without a command: chmod widens it for every account, and
// setfacl -m recalculates the ACL mask, which can widen other entries.
func hostKeysDirFix(dir string) string {
	return "ask an administrator to give this account (uid " + strconv.Itoa(os.Getuid()) + ") read and search access to " +
		shellQuote(dir) + " in a way that fits its existing permissions, then run pen down and pen up, or wait up to an hour"
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func loginName(account string) string { return account }
