package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

// The keys pen identity prints before any join are the keys pen join then joins with: an invite bound to them
// admits the machine, and its identity file is the one identity made.
func TestPenJoinKeepsTheIdentityPenIdentityPrinted(t *testing.T) {
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

	b := tmpStore(t)
	t.Setenv("PEN_TEST_MAIN", "1")
	t.Setenv("PEN_HOME", b.Dir)
	t.Setenv("PEN_SERVICE", "none")
	t.Setenv("PEN_HOSTKEYS", "none")
	t.Setenv("PEN_SSH_DIR", filepath.Join(b.Dir, "ssh"))
	var out, errOut bytes.Buffer
	if code := RunIdentity([]string{"--json"}, &out, &errOut); code != 0 {
		t.Fatalf("pen identity exit %d: %s", code, errOut.String())
	}
	var printed IdentityReply
	if err := json.Unmarshal(out.Bytes(), &printed); err != nil {
		t.Fatalf("pen identity printed %q: %v", out.String(), err)
	}
	if _, err := mesh.Load(b); !os.IsNotExist(err) {
		t.Fatalf("pen identity left a mesh behind (%v); it must not join", err)
	}

	cl, err := daemon.Dial(a)
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()
	fmt.Fprintf(cl, `{"op":"invite","ttlMs":60000,"subject":{"signPub":%q,"noisePub":%q,"name":"b"}}`+"\n", printed.SignPub, printed.NoisePub)
	var inv daemon.InviteReply
	if err := cl.Next(&inv); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	errOut.Reset()
	code := RunJoin([]string{inv.Token, "--name", "b", "--no-service"}, &out, &errOut)
	t.Cleanup(func() { RunDown(nil, io.Discard, io.Discard) })
	if code != 0 {
		t.Fatalf("pen join exit %d: %s", code, errOut.String())
	}
	id, err := b.LoadIdentity()
	if err != nil {
		t.Fatal(err)
	}
	if got := ident.B64.EncodeToString(id.SignPub); got != printed.SignPub || id.NodeID() != printed.NodeID {
		t.Fatalf("joined as %s (%s); pen identity printed %s (%s)", id.NodeID(), got, printed.NodeID, printed.SignPub)
	}
	var ls daemon.LsReply
	if err := daemon.Call(a, daemon.Request{Op: "ls"}, &ls); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, m := range ls.Members {
		found = found || m.NodeID == printed.NodeID && m.NoisePub == printed.NoisePub
	}
	if !found {
		t.Fatalf("the inviter's members %+v do not include the printed identity", ls.Members)
	}
}

// pen identity neither clears an unfinished pen leave nor makes keys the resumed leave would delete.
func TestPenIdentityRefusesWhileALeaveIsUnfinished(t *testing.T) {
	b := tmpStore(t)
	t.Setenv("PEN_HOME", b.Dir)
	if err := b.WriteAtomic(daemon.LeftMarker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	if code := RunIdentity([]string{"--json"}, &out, &errOut); code == 0 {
		t.Fatalf("pen identity printed %q during an unfinished leave", out.String())
	}
	if _, err := b.LoadIdentity(); !os.IsNotExist(err) {
		t.Fatalf("identity.json exists after the refusal (%v)", err)
	}
	if _, err := os.Stat(b.Path(daemon.LeftMarker)); err != nil {
		t.Fatalf("the leave marker is gone: %v", err)
	}
}
