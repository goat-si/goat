//go:build unix

package cli

import "syscall"

var goneErrnos = []error{syscall.ENOTCONN, syscall.EPIPE, syscall.ECONNRESET}
