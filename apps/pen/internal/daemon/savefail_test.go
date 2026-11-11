package daemon

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/wire"
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
	if err := denyCreate(b.st.Dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { allowCreate(b.st.Dir) })
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

	// Q2: the revoke is in b's memory but not on disk. A sync that brings nothing new is not
	// acknowledged either, while the folder stays unwritable.
	again := pushResult(t, a, "b")
	if again == "taken" || !strings.Contains(again, "4507") {
		t.Fatalf("a second sync with nothing new: b answered %q while its state is unsaved", again)
	}
	if err := allowCreate(b.st.Dir); err != nil {
		t.Fatal(err)
	}
	if got := pushResult(t, a, "b"); got != "taken" {
		t.Fatalf("with the folder writable again b answered %q", got)
	}
	if b.d.ls().SaveError != "" {
		t.Fatal("pen ls on b still shows the save error after a save succeeded")
	}
	b.d.Stop()
	err := <-b.done
	b.done <- err
	b2 := start(t, ctx, rs, b.st, nil)
	if _, ok := b2.d.view().Revoked[ident.B64.EncodeToString(c.id.SignPub)]; !ok {
		t.Fatal("after a restart b no longer holds the revoke")
	}
}

func pushResult(t *testing.T, from *node, name string) string {
	t.Helper()
	var res struct{ Results []PushResult }
	if err := Call(from.st, Request{Op: "push"}, &res); err != nil {
		t.Fatal(err)
	}
	for _, r := range res.Results {
		if r.Name == name {
			return r.Result
		}
	}
	t.Fatalf("no push result for %s", name)
	return ""
}

// T2: a relay that refuses the member session with its own 4429 (busy) is not reported as the
// member's mesh being full; only the member's 4508 is.
func TestARelaysBusyRefusalIsNotReportedAsAFullMesh(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	busy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err == nil {
			ws.Close(websocket.StatusCode(wire.CodeCaps), "busy")
		}
	}))
	defer busy.Close()
	a.d.cfgMu.Lock()
	a.d.cfg.SetRelays([]string{busy.URL})
	a.d.cfgMu.Unlock()
	m := a.d.view().Members[ident.B64.EncodeToString(b.id.SignPub)]
	got := a.d.push(ctx, m, time.Minute)
	if strings.Contains(got, "full") || !strings.Contains(got, "busy") {
		t.Fatalf("a relay's 4429 was reported as %q", got)
	}
}
