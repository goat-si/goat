package state

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

// lockFileEx is windows.LockFileEx (a seam for tests).
var lockFileEx = windows.LockFileEx

// lockFile locks the first byte of f exclusively (LockFileEx); without wait it fails with ErrLocked when
// another handle holds it. Windows drops the lock when the handle closes or the process ends.
func lockFile(f *os.File, wait bool) error {
	flags := uint32(windows.LOCKFILE_EXCLUSIVE_LOCK)
	if !wait {
		flags |= windows.LOCKFILE_FAIL_IMMEDIATELY
	}
	err := lockFileEx(windows.Handle(f.Fd()), flags, 0, 1, 0, new(windows.Overlapped))
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return ErrLocked
	}
	return err
}

func unlockFile(f *os.File) {
	_ = windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, new(windows.Overlapped))
}
