package daemon

import (
	"golang.org/x/sys/windows"

	"github.com/goat-si/goat/apps/pen/internal/state"
)

// denyCreate makes dir refuse new files, so a save into it fails. Mode bits do nothing to a folder on
// Windows, so it puts an ACE first in the folder's DACL that denies this user adding files or folders.
func denyCreate(dir string) error {
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
	const addFile, addSubdirectory = 0x2, 0x4 // FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY
	acl, err := windows.ACLFromEntries([]windows.EXPLICIT_ACCESS{{
		AccessPermissions: addFile | addSubdirectory,
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
