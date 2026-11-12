//go:build unix

package state

import "os"

func restrictDir(d string) error { return os.Chmod(d, 0o700) }

// RestrictDir makes a directory usable by its owner only (0700).
func RestrictDir(d string) error { return restrictDir(d) }

// RestrictFile makes a file readable and writable by its owner only (0600).
func RestrictFile(p string) error { return os.Chmod(p, 0o600) }

// OwnerOnly reports whether p grants nothing to anyone but its owner.
func OwnerOnly(p string) (bool, error) {
	fi, err := os.Stat(p)
	if err != nil {
		return false, err
	}
	return fi.Mode().Perm()&0o077 == 0, nil
}
