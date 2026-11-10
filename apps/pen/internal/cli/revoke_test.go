package cli

import (
	"bytes"
	"context"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
)

// pen revoke --compromised names a machine that already left by its name, as pen ls showed it.
func TestRevokeCompromisedFindsAMachineThatAlreadyLeftByName(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a, b := meshOfTwo(t, ctx, rs)
	var left struct{ Results []daemon.PushResult }
	if err := daemon.Call(b, daemon.Request{Op: "leave"}, &left); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PEN_HOME", a.Dir)
	var out, errOut bytes.Buffer
	if code := RunRevoke([]string{"b"}, &out, &errOut); code == 0 {
		t.Fatal("a plain revoke of a machine that already left succeeded")
	}
	errOut.Reset()
	if code := RunRevoke([]string{"--compromised", "b"}, &out, &errOut); code != 0 {
		t.Fatalf("pen revoke --compromised b after b left: exit %d: %s", code, errOut.String())
	}
}
