//go:build unix

package daemon

import (
	"os"
	"strconv"
	"strings"
)

func defaultHostKeyGlob() string { return "/etc/ssh/ssh_host_*_key.pub" }

// hostKeysFix quotes each path whole: a PEN_HOSTKEYS glob can match names with shell syntax.
func hostKeysFix(paths []string) string {
	quoted := make([]string, len(paths))
	for i, p := range paths {
		quoted[i] = shellQuote(p)
	}
	return "make them readable (sudo chmod a+r " + strings.Join(quoted, " ") + "), then run pen down and pen up, or wait up to an hour"
}

// hostKeysDirFix names the access Pen needs without a command: chmod widens it for every account, and
// setfacl -m recalculates the ACL mask, which can widen other entries.
func hostKeysDirFix(dir string) string {
	return "ask an administrator to give this account (uid " + strconv.Itoa(os.Getuid()) + ") read and search access to " +
		shellQuote(dir) + " in a way that fits its existing permissions, then run pen down and pen up, or wait up to an hour"
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func loginName(account string) string { return account }
