package state

import (
	"os"
	"path/filepath"
	"testing"
)

// The state directory holds the node's private keys: OpenDir makes it, and what is written in it,
// readable by this user only (mode bits on unix, the DACL on Windows), even when it existed looser.
func TestOpenDirLeavesTheDirectoryAndItsFilesToTheOwnerAlone(t *testing.T) {
	d := filepath.Join(t.TempDir(), "pen")
	if err := os.MkdirAll(d, 0o755); err != nil {
		t.Fatal(err)
	}
	st, err := OpenDir(d)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.WriteJSON("x.json", map[string]string{"k": "v"}, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.EnsureIdentity(); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{d, st.Path("x.json"), st.Path("identity.json"), st.Path("state.lock")} {
		ok, err := OwnerOnly(p)
		if err != nil || !ok {
			t.Errorf("%s is not private to its owner (%v)", p, err)
		}
	}
}
