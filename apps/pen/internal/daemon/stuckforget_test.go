package daemon

import (
	"context"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
)

// A forget the login service refuses with 403 (this node is not registered under the account) never
// succeeds by retrying, and the revoked machine stays offered to new machines. pen ls shows it so the
// person can sign in here or reset the account's machine list.
func TestAForgetTheServiceRefuses403IsShownInLs(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := loginFake(t)
	st := shortDir(t)
	id := identity(t, st, rs.URL, "a")
	if _, err := mesh.Found(st, id, "a", 1); err != nil {
		t.Fatal(err)
	}
	seen := make(chan bool, 8)
	a := startWith(t, ctx, rs, st, func(o *Options) {
		o.OnForget = func(_ string, _ error, kept bool) { seen <- kept }
	})
	bindTo(t, a, f, f.Key())
	b := newcomer(t)
	as := f.Issue(testSub, "me@example.com", b.SignPub, b.NoisePub, time.Now())
	if _, _, err := AccountJoin(ctx, []string{rs.URL}, b, "b", as, offeredBy(t, a)); err != nil {
		t.Fatal(err)
	}
	f.ForgetStatus.Store(403)
	var r map[string]any
	if err := Call(a.st, Request{Op: "revoke", Subject: ident.B64.EncodeToString(b.SignPub)}, &r); err != nil {
		t.Fatal(err)
	}
	if kept := <-seen; !kept {
		t.Fatal("a 403 forget was dropped")
	}
	ls := a.ls(t)
	if len(ls.Unforgotten) != 1 || ls.Unforgotten[0].NodeID != b.NodeID() || ls.Unforgotten[0].Name != "b" {
		t.Fatalf("ls after a refused forget: unforgotten %+v, want b", ls.Unforgotten)
	}
}
