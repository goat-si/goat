//go:build unix

package daemon

import (
	"os"
	"strconv"
	"strings"
	"testing"
)

// The fixes are commands to paste: a folder with a space stays one argument, the folder fix grants only
// this uid, and neither replaces the existing mode (chmod 755 or 644 would).
func TestHostKeyFixesQuoteThePathAndOnlyAddAccess(t *testing.T) {
	dir := "/srv/my keys"
	d := hostKeysDirFix(dir)
	if !strings.Contains(d, "setfacl -m u:"+strconv.Itoa(os.Getuid())+":rx '/srv/my keys'") {
		t.Fatalf("folder fix %q", d)
	}
	f := hostKeysFix(dir + "/ssh_host_*_key.pub")
	if !strings.Contains(f, "chmod a+r '/srv/my keys'/ssh_host_*_key.pub") {
		t.Fatalf("file fix %q", f)
	}
}
