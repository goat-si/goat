package cli

import (
	"fmt"
	"os"
	"testing"
)

// TestMain lets this test binary stand in for pen when a test starts it as a child (pen up starts itself).
func TestMain(m *testing.M) {
	if os.Getenv("PEN_TEST_MAIN") == "1" {
		if len(os.Args) > 1 && os.Args[1] == "up" {
			os.Exit(RunUp(os.Args[2:], os.Stdout, os.Stderr))
		}
		fmt.Fprintln(os.Stderr, "PEN_TEST_MAIN: only up is wired", os.Args[1:])
		os.Exit(2)
	}
	os.Exit(m.Run())
}
