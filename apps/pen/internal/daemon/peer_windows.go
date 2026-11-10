package daemon

import (
	"net"
	"unsafe"

	"golang.org/x/sys/windows"
)

// sioAFUnixGetPeerPID is SIO_AF_UNIX_GETPEERPID (_WSAIOR(IOC_VENDOR, 256), afunix.h).
const sioAFUnixGetPeerPID = 0x58000100

// peerIsOwner reports whether the process on the other end of a control connection runs as this
// process's user. Windows does not refuse an AF_UNIX connect on the socket file's DACL (a process
// whose token held the user SID only for deny passed it on Windows 11 26200), so the daemon checks
// the peer's token itself. Any failure to identify the peer counts as a stranger.
func peerIsOwner(c net.Conn) bool {
	uc, ok := c.(*net.UnixConn)
	if !ok {
		return false
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return false
	}
	var pid uint32
	var ioErr error
	if err := raw.Control(func(fd uintptr) {
		var n uint32
		ioErr = windows.WSAIoctl(windows.Handle(fd), sioAFUnixGetPeerPID, nil, 0, (*byte)(unsafe.Pointer(&pid)), 4, &n, nil, 0)
	}); err != nil || ioErr != nil || pid == 0 {
		return false
	}
	peer, err := processUser(pid)
	if err != nil {
		return false
	}
	self, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return false
	}
	return peer.User.Attributes&windows.SE_GROUP_USE_FOR_DENY_ONLY == 0 && peer.User.Sid.Equals(self.User.Sid)
}

func processUser(pid uint32) (*windows.Tokenuser, error) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(h)
	var tok windows.Token
	if err := windows.OpenProcessToken(h, windows.TOKEN_QUERY, &tok); err != nil {
		return nil, err
	}
	defer tok.Close()
	return tok.GetTokenUser()
}
