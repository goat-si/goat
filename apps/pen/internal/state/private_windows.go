package state

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

// fileAllAccess is FILE_ALL_ACCESS. A generic right in an inheritable ACE would split into an
// effective ACE and an inherit-only one; the specific mask keeps one ACE.
const fileAllAccess = windows.STANDARD_RIGHTS_REQUIRED | windows.SYNCHRONIZE | 0x1ff

func tokenUser() (*windows.SID, error) {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	return u.User.Sid.Copy()
}

// restrict replaces the DACL of p with one protected ACE for this process's user, inherited by new
// files and folders when inherit is set. Mode bits do not protect anything on Windows.
func restrict(p string, inherit bool) error {
	if ok, err := ownerOnly(p, inherit); err == nil && ok {
		return nil
	}
	sid, err := tokenUser()
	if err != nil {
		return err
	}
	inheritance := uint32(windows.NO_INHERITANCE)
	if inherit {
		inheritance = windows.SUB_CONTAINERS_AND_OBJECTS_INHERIT
	}
	acl, err := windows.ACLFromEntries([]windows.EXPLICIT_ACCESS{{
		AccessPermissions: fileAllAccess,
		AccessMode:        windows.SET_ACCESS,
		Inheritance:       inheritance,
		Trustee: windows.TRUSTEE{
			TrusteeForm:  windows.TRUSTEE_IS_SID,
			TrusteeType:  windows.TRUSTEE_IS_USER,
			TrusteeValue: windows.TrusteeValueFromSID(sid),
		},
	}}, nil)
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(p, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil)
}

func restrictDir(d string) error { return restrict(d, true) }

// RestrictDir gives a directory one ACE, for the current user, that its files and folders inherit.
func RestrictDir(d string) error { return restrictDir(d) }

// RestrictFile gives a file one ACE, for the current user.
func RestrictFile(p string) error { return restrict(p, false) }

// OwnerOnly reports whether every ACE of p allows the current user and nobody else.
func OwnerOnly(p string) (bool, error) { return ownerOnly(p, false) }

func ownerOnly(p string, inherit bool) (bool, error) {
	sd, err := windows.GetNamedSecurityInfo(p, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return false, err
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil {
		// A missing DACL grants everyone everything.
		return false, err
	}
	sid, err := tokenUser()
	if err != nil {
		return false, err
	}
	const inherits = windows.OBJECT_INHERIT_ACE | windows.CONTAINER_INHERIT_ACE
	for i := range uint32(dacl.AceCount) {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			return false, err
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || !(*windows.SID)(unsafe.Pointer(&ace.SidStart)).Equals(sid) {
			return false, nil
		}
		if inherit && ace.Header.AceFlags&inherits != inherits {
			return false, nil
		}
	}
	return dacl.AceCount > 0, nil
}
