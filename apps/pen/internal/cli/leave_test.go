package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

type serviceCall struct {
	cmd         string
	unitPresent bool
}

// fakeSystemd puts a pen.service unit under a scratch HOME and records service commands.
func fakeSystemd(t *testing.T) (home string, calls *[]serviceCall) {
	t.Helper()
	home, err := os.MkdirTemp(tmpRoot(), "penh")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	setHome(t, home)
	t.Setenv("PEN_HOME", "")
	if err := writeFile(unitPath(), "[Service]\nRestart=always\n"); err != nil {
		t.Fatal(err)
	}
	oldOS, oldRun := serviceOS, run
	t.Cleanup(func() { serviceOS, run = oldOS, oldRun })
	serviceOS = "linux"
	calls = &[]serviceCall{}
	run = func(name string, args ...string) error {
		_, err := os.Stat(unitPath())
		*calls = append(*calls, serviceCall{name + " " + strings.Join(args, " "), err == nil})
		return nil
	}
	return home, calls
}

func TestLeaveThatFailsKeepsTheServiceAndSaysSo(t *testing.T) {
	_, calls := fakeSystemd(t)
	var out, errOut bytes.Buffer
	if code := RunLeave(nil, &out, &errOut); code != 1 {
		t.Fatalf("exit %d, want 1", code)
	}
	if _, err := os.Stat(unitPath()); err != nil {
		t.Fatalf("a failed leave removed the unit: %v", err)
	}
	if len(*calls) != 0 {
		t.Fatalf("a failed leave ran %v", *calls)
	}
	if !strings.Contains(errOut.String(), "service") {
		t.Fatalf("stderr %q does not say the service was kept", errOut.String())
	}
}

func TestLeaveStopsTheUnitWithDisableNowBeforeRemovingIt(t *testing.T) {
	home, calls := fakeSystemd(t)
	ctx := t.Context()
	rs := relaytest.New()
	defer rs.Close()
	st, err := state.OpenDir(filepath.Join(home, ".pen"))
	if err != nil {
		t.Fatal(err)
	}
	id, _, _ := st.EnsureIdentity()
	st.SaveConfig(state.Config{Relay: rs.URL, Name: "a"})
	if _, err := mesh.Found(st, id, "a", 1); err != nil {
		t.Fatal(err)
	}
	startNode(t, ctx, rs, st)
	var out, errOut bytes.Buffer
	if code := RunLeave(nil, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	if len(*calls) == 0 || (*calls)[0].cmd != "systemctl --user disable --now pen.service" || !(*calls)[0].unitPresent {
		t.Fatalf("service calls %v; want disable --now first, while the unit still exists", *calls)
	}
	if _, err := os.Stat(unitPath()); !os.IsNotExist(err) {
		t.Fatalf("unit still present after leave: %v", err)
	}
	last := (*calls)[len(*calls)-1]
	if last.cmd != "systemctl --user daemon-reload" || last.unitPresent {
		t.Fatalf("last call %+v; want daemon-reload after the unit is gone", last)
	}
}
