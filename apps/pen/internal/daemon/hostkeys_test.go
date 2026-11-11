package daemon

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
)

// P1: on Windows sshd's .pub files can be readable by Administrators only. A key file that exists but
// cannot be read must not vanish silently: the readable keys are still published, and pen ls on the
// member names the file it could not read.
func TestAnUnreadableHostKeyFileIsReportedAndTheReadableKeysArePublished(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	keys := t.TempDir()
	if err := os.WriteFile(filepath.Join(keys, "ssh_host_ed25519_key.pub"), []byte("ssh-ed25519 AAAAC3Nza host\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A directory matches the glob and fails to read on every OS, also for root and an administrator.
	unreadable := filepath.Join(keys, "ssh_host_rsa_key.pub")
	if err := os.Mkdir(unreadable, 0o755); err != nil {
		t.Fatal(err)
	}
	st := shortDir(t)
	id := identity(t, st, rs.URL, "w")
	if _, err := mesh.Found(st, id, "w", 1); err != nil {
		t.Fatal(err)
	}
	n := startWith(t, ctx, rs, st, func(o *Options) { o.HostKeyGlob = filepath.Join(keys, "ssh_host_*_key.pub") })
	n.d.checkHostKeys(ctx)

	if got := n.d.view().Members[n.d.selfKey()].HostKeys; !slices.Equal(got, []string{"ssh-ed25519 AAAAC3Nza"}) {
		t.Fatalf("published host keys %q, want the readable ed25519 key", got)
	}
	if e := n.d.ls().HostKeysError; !strings.Contains(e, unreadable) {
		t.Fatalf("pen ls host key error %q does not name %s", e, unreadable)
	}
	if err := os.Remove(unreadable); err != nil {
		t.Fatal(err)
	}
	n.d.checkHostKeys(ctx)
	if e := n.d.ls().HostKeysError; e != "" {
		t.Fatalf("pen ls still reports %q once every key file reads", e)
	}
}
