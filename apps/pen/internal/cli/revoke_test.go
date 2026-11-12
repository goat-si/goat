package cli

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/state"
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

// A departed machine and a current one can share a name. Revoking that name as compromised must
// not pick one: it fails, names both machines, and revokes neither.
func TestRevokeCompromisedRefusesANameADepartedAndACurrentMachineShare(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a, b := meshOfTwo(t, ctx, rs)
	bid, _, _ := b.EnsureIdentity()
	var res struct{ Results []daemon.PushResult }
	if err := daemon.Call(a, daemon.Request{Op: "revoke", Subject: ident.B64.EncodeToString(bid.SignPub)}, &res); err != nil {
		t.Fatal(err)
	}
	var inv struct{ Token string }
	if err := daemon.Call(a, daemon.Request{Op: "invite", TTLMs: 60000}, &inv); err != nil {
		t.Fatal(err)
	}
	tok, _ := mesh.ParseToken(inv.Token)
	b2 := tmpStore(t)
	b2id, _, _ := b2.EnsureIdentity()
	b2.SaveConfig(state.Config{Relay: rs.URL, Name: "b"})
	s, err := daemon.Join(ctx, b2, b2id, tok, "b")
	if err != nil {
		t.Fatal(err)
	}
	s.Save()
	startNode(t, ctx, rs, b2)
	t.Setenv("PEN_HOME", a.Dir)
	var out, errOut bytes.Buffer
	if code := RunRevoke([]string{"--compromised", "b"}, &out, &errOut); code == 0 {
		t.Fatalf("pen revoke --compromised b revoked one of two machines named b: %s", out.String())
	}
	for _, id := range []string{bid.NodeID(), b2id.NodeID()} {
		if !strings.Contains(errOut.String(), id) {
			t.Fatalf("the refusal does not name %s: %s", id, errOut.String())
		}
	}
	var ls daemon.LsReply
	if err := daemon.Call(a, daemon.Request{Op: "ls"}, &ls); err != nil {
		t.Fatal(err)
	}
	if _, err := Resolve(lsMembers(ls), b2id.NodeID()); err != nil {
		t.Fatalf("the current b is no longer a member: %v", err)
	}
}

// The refusal's suggested commands must each work, and a fingerprint can be given by its start as
// pen ls prints it, like a node id.
func TestRevokeCompromisedTakesAFingerprintPrefixAndSuggestsCommandsThatWork(t *testing.T) {
	key := func(b byte) string { return ident.B64.EncodeToString(bytes.Repeat([]byte{b}, 32)) }
	cur := mesh.Member{Name: "b", NodeID: "currentnodeidaaaaaaaaaaaaa", NoisePub: key(1), SignPub: key(3)}
	old := mesh.Member{Name: "b", NodeID: "departednodeidaaaaaaaaaaaa", NoisePub: key(2), SignPub: key(4)}
	ls := daemon.LsReply{Members: []daemon.LsMember{{Member: cur}}, Revoked: []daemon.LsRevoked{{Member: old}}}
	_, err := resolveCompromised(ls, "b")
	if err == nil {
		t.Fatal("two machines named b resolved to one")
	}
	var suggested []string
	for _, line := range strings.Split(err.Error(), "\n") {
		if cmd, ok := strings.CutPrefix(strings.TrimSpace(line), "pen revoke --compromised "); ok {
			suggested = append(suggested, cmd)
		}
	}
	if len(suggested) != 2 {
		t.Fatalf("want one command per machine, got %q in %s", suggested, err)
	}
	for i, want := range []mesh.Member{cur, old} {
		got, err := resolveCompromised(ls, suggested[i])
		if err != nil || got.NodeID != want.NodeID {
			t.Fatalf("suggested %q resolves to %q (%v), want %s", suggested[i], got.NodeID, err, want.NodeID)
		}
	}
	fp := fingerprintOf(old.NoisePub)
	for _, prefix := range []string{fp[:9], strings.ReplaceAll(fp[:9], " ", "")} {
		got, err := resolveCompromised(ls, prefix)
		if err != nil || got.NodeID != old.NodeID {
			t.Fatalf("fingerprint prefix %q resolves to %q (%v), want %s", prefix, got.NodeID, err, old.NodeID)
		}
	}
}

// A member can take a name that is another machine's fingerprint start. Revoking that string as
// compromised must not pick either machine: it names both, with a command for each that works.
func TestRevokeCompromisedRefusesANameThatIsAlsoAnotherMachinesFingerprintStart(t *testing.T) {
	key := func(b byte) string { return ident.B64.EncodeToString(bytes.Repeat([]byte{b}, 32)) }
	target := mesh.Member{Name: "c", NodeID: "targetnodeidaaaaaaaaaaaaaa", NoisePub: key(1), SignPub: key(3)}
	fp := fingerprintOf(target.NoisePub)
	squatter := mesh.Member{Name: strings.ToLower(fp[:4] + fp[5:9]), NodeID: "squatternodeidaaaaaaaaaaaa", NoisePub: key(2), SignPub: key(4)}
	ls := daemon.LsReply{Members: []daemon.LsMember{{Member: target}, {Member: squatter}}}
	m, err := resolveCompromised(ls, squatter.Name)
	if err == nil {
		t.Fatalf("%q resolved to %s, though it names one machine and starts another's fingerprint", squatter.Name, m.NodeID)
	}
	for _, id := range []string{target.NodeID, squatter.NodeID} {
		if !strings.Contains(err.Error(), "pen revoke --compromised "+normalFingerprint(fingerprintOf(map[string]string{target.NodeID: target.NoisePub, squatter.NodeID: squatter.NoisePub}[id]))) {
			t.Fatalf("the refusal does not offer a command for %s: %v", id, err)
		}
	}
}
