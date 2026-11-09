package cli

import (
	"bytes"
	"errors"
	"os"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

func TestUpForegroundAfterLeaveExitsZeroWithoutANewIdentityOrMesh(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PEN_HOME", dir)
	st, err := state.OpenDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(st.Path(daemon.LeftMarker), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	if code := RunUp([]string{"--foreground"}, &out, &errOut); code != 0 {
		t.Fatalf("exit %d (%s); a service restart after leave must not loop", code, errOut.String())
	}
	if _, err := st.LoadIdentity(); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a new identity was created after leave: %v", err)
	}
	if _, err := os.Stat(st.Path("mesh.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a new mesh was founded after leave")
	}
}
