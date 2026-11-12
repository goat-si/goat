package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// TestMain lets this test binary stand in for pen when a test starts it as a child (pen up starts itself),
// and points the default home and state directory at a scratch one, so no test opens the real ~/.pen
// (pen ssh-config, for one, opens the state directory when it exists or not).
func TestMain(m *testing.M) {
	if os.Getenv("PEN_TEST_MAIN") == "1" {
		if len(os.Args) > 1 && os.Args[1] == "up" {
			os.Exit(RunUp(os.Args[2:], os.Stdout, os.Stderr))
		}
		fmt.Fprintln(os.Stderr, "PEN_TEST_MAIN: only up is wired", os.Args[1:])
		os.Exit(2)
	}
	home, err := os.MkdirTemp(tmpRoot(), "penhome")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Setenv("HOME", home)
	os.Setenv("USERPROFILE", home)
	os.Setenv("PEN_HOME", filepath.Join(home, ".pen"))
	code := m.Run()
	os.RemoveAll(home)
	os.Exit(code)
}
