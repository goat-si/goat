package daemon

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
)

func onlineIn(ls LsReply, name string) bool {
	for _, m := range ls.Members {
		if m.Name == name {
			return m.Online
		}
	}
	return false
}

func TestAMemberWhoseRelayStopsCarryingItIsShownOfflineAfterTheNextSync(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	a.d.pushAll(ctx)
	if !onlineIn(a.d.ls(), "b") {
		t.Fatal("b not online after a successful sync")
	}
	// A sleeping machine keeps its uplink registered at the relay, so dials reach the relay and
	// never get an answer: no 4404, only a timeout.
	release := rs.HoldForwarding()
	defer release()
	m, _ := a.d.view().MemberByNoise(b.id.NoisePub)
	pctx, pcancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer pcancel()
	if res := a.d.push(pctx, m); res == "ok" {
		t.Fatalf("push through a held relay answered %q", res)
	}
	if onlineIn(a.d.ls(), "b") {
		t.Fatal("b still shown online after a sync to it failed")
	}
}

func TestTheDashboardRefreshesPresenceAtMostEvery30sWhileItIsPolled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	clk := &clock{}
	clk.ms.Store(time.Now().UnixMilli())
	a := founder(t, ctx, rs, "a", clk)
	refreshed := make(chan struct{}, 4)
	a.d.opt.PresenceDone = func() { refreshed <- struct{}{} }
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	_ = b
	d, tok := openDash(t, a)
	bearer := d.login(tok)
	want(t, "first state", d.get("/api/state", bearer), http.StatusOK)
	<-refreshed // the first poll refreshes at once
	if !onlineIn(a.d.ls(), "b") {
		t.Fatal("b not online after the dashboard's presence refresh")
	}
	want(t, "second state", d.get("/api/state", bearer), http.StatusOK)
	select {
	case <-refreshed:
		t.Fatal("a second poll within 30 s refreshed again")
	default:
	}
	clk.advance(31 * time.Second)
	want(t, "state after 31 s", d.get("/api/state", bearer), http.StatusOK)
	<-refreshed
	_ = ident.B64
}
