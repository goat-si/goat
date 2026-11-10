package daemon

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// TestHelperDialControl is the child of the test below: it dials PEN_TEST_DIAL and exits 0 when the
// connection opens, 3 when it is refused. Run without the variable it does nothing.
func TestHelperDialControl(t *testing.T) {
	p := os.Getenv("PEN_TEST_DIAL")
	if p == "" {
		return
	}
	c, err := net.Dial("unix", p)
	if err != nil {
		fmt.Fprintln(os.Stderr, "dial:", err)
		os.Exit(3)
	}
	c.Close()
	os.Exit(0)
}

// Another user on the machine must not drive the daemon. The child runs with this user's token minus
// the user SID (deny-only), which is what another account looks like to the socket's DACL; it must be
// refused, and the same child must get in once the DACL admits Everyone, so the refusal comes from the
// DACL and not from the child failing to run.
func TestControlSocketRefusesAProcessWithoutTheOwnersSID(t *testing.T) {
	st := shortDir(t)
	d := &Daemon{st: st}
	ln, err := d.listenControl()
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	exe, dir := runnableCopy(t)
	tok := restrictedToken(t)
	dial := func() (int, string) {
		cmd := exec.Command(exe, "-test.run=^TestHelperDialControl$")
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "PEN_TEST_DIAL="+SocketPath(st))
		cmd.SysProcAttr = &syscall.SysProcAttr{Token: syscall.Token(tok)}
		out, err := cmd.CombinedOutput()
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return exit.ExitCode(), string(out)
		}
		if err != nil {
			t.Fatalf("starting the restricted child: %v", err)
		}
		return 0, string(out)
	}
	if code, out := dial(); code != 3 {
		t.Fatalf("a process without the owner's SID: exit %d, want 3 (refused): %s", code, out)
	}
	setDACL(t, SocketPath(st), windows.GENERIC_ALL, false)
	if code, out := dial(); code != 0 {
		t.Fatalf("the restricted child could not connect to a socket open to Everyone: exit %d: %s", code, out)
	}
}

// restrictedToken is this process's token with its user SID made deny-only.
func restrictedToken(t *testing.T) windows.Token {
	t.Helper()
	var self windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_DUPLICATE|windows.TOKEN_ASSIGN_PRIMARY|windows.TOKEN_QUERY, &self); err != nil {
		t.Fatal(err)
	}
	defer self.Close()
	u, err := self.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	disable := windows.SIDAndAttributes{Sid: u.User.Sid}
	var tok windows.Token
	r, _, err := windows.NewLazySystemDLL("advapi32.dll").NewProc("CreateRestrictedToken").Call(
		uintptr(self), 0, 1, uintptr(unsafe.Pointer(&disable)), 0, 0, 0, 0, uintptr(unsafe.Pointer(&tok)))
	if r == 0 {
		t.Fatalf("CreateRestrictedToken: %v", err)
	}
	t.Cleanup(func() { tok.Close() })
	return tok
}

// runnableCopy copies the test binary into a directory Everyone may read and run, since the
// restricted child cannot use files granted only to this user.
func runnableCopy(t *testing.T) (exe, dir string) {
	t.Helper()
	dir = t.TempDir()
	setDACL(t, dir, windows.GENERIC_READ|windows.GENERIC_EXECUTE, true)
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	src, err := os.Open(self)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	exe = filepath.Join(dir, "child.test.exe")
	dst, err := os.Create(exe)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(dst, src); err != nil {
		t.Fatal(err)
	}
	if err := dst.Close(); err != nil {
		t.Fatal(err)
	}
	return exe, dir
}

// setDACL gives p a protected DACL: this user full control and Everyone the given rights.
func setDACL(t *testing.T, p string, everyone windows.ACCESS_MASK, inherit bool) {
	t.Helper()
	world, err := windows.CreateWellKnownSid(windows.WinWorldSid)
	if err != nil {
		t.Fatal(err)
	}
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	inheritance := uint32(windows.NO_INHERITANCE)
	if inherit {
		inheritance = windows.SUB_CONTAINERS_AND_OBJECTS_INHERIT
	}
	entry := func(sid *windows.SID, mask windows.ACCESS_MASK) windows.EXPLICIT_ACCESS {
		return windows.EXPLICIT_ACCESS{AccessPermissions: mask, AccessMode: windows.GRANT_ACCESS, Inheritance: inheritance,
			Trustee: windows.TRUSTEE{TrusteeForm: windows.TRUSTEE_IS_SID, TrusteeValue: windows.TrusteeValueFromSID(sid)}}
	}
	acl, err := windows.ACLFromEntries([]windows.EXPLICIT_ACCESS{entry(u.User.Sid, windows.GENERIC_ALL), entry(world, everyone)}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(p, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		t.Fatal(err)
	}
}
