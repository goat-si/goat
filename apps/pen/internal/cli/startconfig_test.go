package cli

import (
	"errors"
	"slices"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/state"
)

// W2: pen login or pen up applying its flags keeps a relay change the daemon made after the command
// read its inputs: the change is one read-modify-write under the state lock.
func TestAStartKeepsARelayChangeMadeWhileItRan(t *testing.T) {
	st, err := state.OpenDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SaveConfig(state.Config{Name: "a", Relays: []string{"https://one.example"}}); err != nil {
		t.Fatal(err)
	}
	afterConfigRead = func() {
		st.UpdateConfig(func(c *state.Config) { c.SetRelays([]string{"https://one.example", "https://two.example"}) })
	}
	defer func() { afterConfigRead = nil }()
	called := false
	duringConfigUpdate = func() {
		called = true
		unlock, err := state.TryLock(st.Path("state.lock"))
		if unlock != nil {
			unlock()
		}
		if !errors.Is(err, state.ErrLocked) {
			t.Errorf("config read-to-write step must hold the state lock; TryLock: %v", err)
		}
	}
	defer func() { duringConfigUpdate = nil }()
	if _, err := startConfig(st, nil, "b"); err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("config read-to-write hook did not run")
	}
	got, err := st.LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "b" || !slices.Equal(got.RelayList(), []string{"https://one.example", "https://two.example"}) {
		t.Fatalf("config after the start: name %q relays %v, want b and both relays", got.Name, got.RelayList())
	}
}
