package state

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func daclProtected(t *testing.T, p string) bool {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(p, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	control, _, err := sd.Control()
	if err != nil {
		t.Fatal(err)
	}
	return control&windows.SE_DACL_PROTECTED != 0
}

// A state directory whose only ACE is the user's, inherited from an owner-only parent, looks private but
// would take any ACE a later change to the parent adds; OpenDir must protect it anyway.
func TestOpenDirProtectsADirectoryThatOnlyInheritsTheUsersACE(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "parent")
	if err := os.Mkdir(parent, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := RestrictDir(parent); err != nil {
		t.Fatal(err)
	}
	d := filepath.Join(parent, "pen")
	if err := os.Mkdir(d, 0o700); err != nil {
		t.Fatal(err)
	}
	if ok, err := OwnerOnly(d); err != nil || !ok || daclProtected(t, d) {
		t.Fatalf("setup: child should inherit only the user's ACE without protection (owner-only %v, %v)", ok, err)
	}
	if _, err := OpenDir(d); err != nil {
		t.Fatal(err)
	}
	if !daclProtected(t, d) {
		t.Fatal("OpenDir left the state directory's DACL unprotected")
	}
	sock := filepath.Join(d, "control.sock")
	if err := os.WriteFile(sock, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RestrictFile(sock); err != nil {
		t.Fatal(err)
	}
	if !daclProtected(t, sock) {
		t.Fatal("RestrictFile left an inherited-only DACL unprotected")
	}
}
