package daemon

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"

	"github.com/goat-si/goat/apps/pen/internal/state"
)

// denyCreate makes dir refuse new files, so a save into it fails. Mode bits do nothing to a folder on
// Windows, so it puts an ACE first in the folder's DACL that denies this user adding files or folders.
func denyCreate(dir string) error {
	const addFile, addSubdirectory = 0x2, 0x4 // FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY
	return denyFirst(dir, addFile|addSubdirectory)
}

// unlistableDir is a key folder this user may not list (access denied, as an ACL-protected
// %ProgramData%\ssh gives); a file in place of a folder reads as missing on Windows.
func unlistableDir(t *testing.T) string {
	p := filepath.Join(t.TempDir(), "ssh")
	if err := os.Mkdir(p, 0o755); err != nil {
		t.Fatal(err)
	}
	const listDirectory = 0x1 // FILE_LIST_DIRECTORY
	if err := denyFirst(p, listDirectory); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { // before TempDir's cleanup, which must list it
		if err := state.RestrictDir(p); err != nil {
			t.Error(err)
		}
	})
	if _, err := os.ReadDir(p); !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("listing the denied folder gave %v, want access denied", err)
	}
	return p
}

// denyFirst puts an ACE first in dir's DACL that denies this user mask.
func denyFirst(dir string, mask windows.ACCESS_MASK) error {
	sd, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	old, _, err := sd.DACL()
	if err != nil {
		return err
	}
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	acl, err := windows.ACLFromEntries([]windows.EXPLICIT_ACCESS{{
		AccessPermissions: mask,
		AccessMode:        windows.DENY_ACCESS,
		Inheritance:       windows.NO_INHERITANCE,
		Trustee: windows.TRUSTEE{
			TrusteeForm:  windows.TRUSTEE_IS_SID,
			TrusteeType:  windows.TRUSTEE_IS_USER,
			TrusteeValue: windows.TrusteeValueFromSID(u.User.Sid),
		},
	}}, old)
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil)
}

// allowCreate undoes denyCreate: the state folder gets its one owner ACE back.
func allowCreate(dir string) error { return state.RestrictDir(dir) }
