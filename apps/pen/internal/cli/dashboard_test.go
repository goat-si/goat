package cli

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

// The one-time token stays out of the terminal's scrollback when the browser opened it.
func TestDashboardPrintsTheTokenLinkOnlyWhenItCannotOpenIt(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := tmpStore(t)
	aid, _, _ := a.EnsureIdentity()
	a.SaveConfig(state.Config{Relay: rs.URL, Name: "a"})
	if _, err := mesh.Found(a, aid, "a", 1); err != nil {
		t.Fatal(err)
	}
	startNode(t, ctx, rs, a)
	t.Setenv("PEN_HOME", a.Dir)
	defer func(old func(string) error) { openFile = old }(openFile)
	var opened []string
	var openErr error
	openFile = func(path string) error {
		opened = append(opened, path)
		return openErr
	}
	run := func(args ...string) string {
		var out, errOut bytes.Buffer
		if code := RunDashboard(args, &out, &errOut); code != 0 {
			t.Fatalf("pen dashboard %v: exit %d: %s", args, code, errOut.String())
		}
		return out.String()
	}
	out := run()
	if strings.Contains(out, "#t=") || len(opened) != 1 || !strings.Contains(out, "pen dashboard --stop") {
		t.Fatalf("opened %v; output:\n%s", opened, out)
	}
	if out := run("--no-open"); !strings.Contains(out, "#t=") || len(opened) != 1 {
		t.Fatalf("--no-open: opened %v; output:\n%s", opened, out)
	}
	openErr = errors.New("no browser")
	if out := run(); !strings.Contains(out, "#t=") || !strings.Contains(out, "no browser") {
		t.Fatalf("failed open; output:\n%s", out)
	}
}
