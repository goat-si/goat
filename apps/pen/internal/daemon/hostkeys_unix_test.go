//go:build unix

package daemon

import (
	"os"
	"strconv"
	"strings"
	"testing"
)

// A pasted file fix keeps a folder with a space as one argument and only adds read access (chmod 644
// would replace the mode). The folder fix names what Pen needs and gives no command: chmod would widen
// it for every account, and setfacl -m recalculates the mask, which can widen other entries.
func TestHostKeyFixesQuoteThePathAndOnlyAddAccess(t *testing.T) {
	dir := "/srv/my keys"
	d := hostKeysDirFix(dir)
	if !strings.Contains(d, "uid "+strconv.Itoa(os.Getuid())) || !strings.Contains(d, "'/srv/my keys'") ||
		strings.Contains(d, "chmod") || strings.Contains(d, "setfacl") {
		t.Fatalf("folder fix %q", d)
	}
	// The fix names the files that failed, each quoted whole: a PEN_HOSTKEYS glob may hold shell syntax.
	f := hostKeysFix([]string{dir + "/ssh_host_$(id)_key.pub", "/etc/ssh/ssh_host_rsa_key.pub"})
	if !strings.Contains(f, "chmod a+r '/srv/my keys/ssh_host_$(id)_key.pub' '/etc/ssh/ssh_host_rsa_key.pub'") {
		t.Fatalf("file fix %q", f)
	}
}
