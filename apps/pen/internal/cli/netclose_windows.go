package cli

import "golang.org/x/sys/windows"

// Windows reports a vanished peer with Winsock codes, which errors.Is does not match to ECONNRESET.
var goneErrnos = []error{windows.WSAENOTCONN, windows.WSAECONNRESET, windows.WSAECONNABORTED, windows.WSAESHUTDOWN, windows.ERROR_NETNAME_DELETED}
