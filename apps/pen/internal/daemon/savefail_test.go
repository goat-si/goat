package daemon

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
)

// N4: a member that cannot write its state folder does not acknowledge a revoke it was sent: the
// sender's push reports it not taken, and pen ls on the member says its state cannot be written.
func TestAMemberThatCannotSaveDoesNotAcknowledgeARevoke(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	c := joiner(t, ctx, rs, a.invite(t, time.Minute), "c")
	if err := os.Chmod(b.st.Dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(b.st.Dir, 0o700) })
	var res struct{ Results []PushResult }
	if err := Call(a.st, Request{Op: "revoke", Subject: ident.B64.EncodeToString(c.id.SignPub)}, &res); err != nil {
		t.Fatal(err)
	}
	for _, r := range res.Results {
		if r.Name == "b" && r.Result == "taken" {
			t.Fatal("b acknowledged a revoke it could not save")
		}
		if r.Name == "b" && !strings.Contains(r.Result, "4507") {
			t.Fatalf("b's push result %q does not say why", r.Result)
		}
	}
	if b.d.ls().SaveError == "" {
		t.Fatal("pen ls on b does not say its state cannot be written")
	}
}
