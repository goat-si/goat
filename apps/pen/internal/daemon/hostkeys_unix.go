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

// hostKeysDirFix grants this uid alone list and enter through an ACL, keeping the folder's mode.
func hostKeysDirFix(dir string) string {
	return "ask an administrator to let this account list it without changing its other permissions (on Linux: sudo setfacl -m u:" +
		strconv.Itoa(os.Getuid()) + ":rx " + shellQuote(dir) + "), then run pen down and pen up, or wait up to an hour"
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func loginName(account string) string { return account }
