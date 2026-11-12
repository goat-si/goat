package daemon

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
)

func trafficLine(node, relay string, in, out any) string {
	b, _ := json.Marshal(map[string]any{"op": "traffic.report", "node": node, "relay": relay, "in": in, "out": out})
	return string(b)
}

func otherNodeID(t *testing.T) string {
	t.Helper()
	k := make([]byte, 32)
	rand.Read(k)
	return ident.NodeID(k)
}

func TestTrafficReportCountsForAMemberAndShowsInLs(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	self := a.d.NodeID()
	for _, line := range []string{
		trafficLine(self, rs.URL, 1000, 20),
		trafficLine(self, rs.URL, 5, 1),
		trafficLine(self, "https://not-a-relay-of-this-node.example", 7, 0),
	} {
		if h := rawControl(t, a, line); h.reply["t"] != "counted" {
			t.Fatalf("%s answered %v, want counted", line, h.reply)
		}
	}
	ls := a.ls(t)
	tr := ls.Members[0].Traffic24h
	if tr == nil || tr.In != 1012 || tr.Out != 21 {
		t.Fatalf("member traffic %+v, want in 1012 out 21", tr)
	}
	want := []RelayTraffic{{URL: "", In: 7}, {URL: rs.URL, In: 1005, Out: 21}}
	if fmt.Sprint(tr.Relays) != fmt.Sprint(want) || fmt.Sprint(ls.Relays24h) != fmt.Sprint(want) {
		t.Fatalf("relays %+v and %+v, want %+v (a relay this node does not list counts as other)", tr.Relays, ls.Relays24h, want)
	}
	if ls.TrafficSince == 0 {
		t.Fatal("trafficSince missing while totals are shown")
	}
}

// The control socket is owner-only, but a buggy or hostile local program must not make the daemon allocate per
// report: every refusal leaves the table as it was, and accepted reports cannot add keys beyond the view's members
// times this node's relays plus one.
func TestTrafficReportsCannotGrowTheDaemonWithoutBound(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	self := a.d.NodeID()
	refused := []string{
		trafficLine(self, rs.URL, json.Number("9007199254740992"), 0),
		trafficLine(self, rs.URL, json.Number("18446744073709551616"), 0),
		trafficLine(self, rs.URL, -1, 0),
		trafficLine(self, rs.URL, 1.5, 0),
		trafficLine(self, rs.URL, json.Number("1e3"), 0),
		trafficLine(self, rs.URL, "1", 0),
		trafficLine(otherNodeID(t), rs.URL, 1, 1),
		trafficLine("not a node id", rs.URL, 1, 1),
		trafficLine(self, strings.Repeat("x", 513), 1, 1),
		`{"op":"traffic.report","node":"` + self + `","relay":"","in":1,"out":1,"extra":1}`,
		`{"op":"traffic.report","node":"` + self + `","relay":"","in":1,"in":2,"out":1}`,
		`{"op":"traffic.report","node":"` + self + `","relay":"","IN":1,"out":1}`,
		`{"op":"traffic.report","node":"` + self + `","relay":"","in":1,"out":1} {}`,
	}
	for _, line := range []string{
		`{"op":"traffic.report","node":"` + self + `","in":1,"out":1}`,
		`{"op":"traffic.report","node":"` + self + `","relay":"","in":1}`,
		`{"op":"traffic.report","node":"` + self + `","relay":"","in":null,"out":1}`,
		`{"op":"traffic.report","node":"` + self + `","relay":null,"in":1,"out":1}`,
		`{"op":"traffic.report","node":null,"relay":"","in":1,"out":1}`,
	} {
		refused = append(refused, line)
	}
	for _, line := range refused {
		if h := rawControl(t, a, line); h.reply["error"] == nil {
			t.Fatalf("%s answered %v, want a refusal", line, h.reply)
		}
	}
	if n := a.d.traffic.Len(); n != 0 {
		t.Fatalf("%d entries after refused reports, want 0", n)
	}
	for i := range 300 {
		h := rawControl(t, a, trafficLine(self, fmt.Sprintf("https://flood-%d.example", i), 1, 1))
		if h.reply["t"] != "counted" {
			t.Fatalf("report %d answered %v", i, h.reply)
		}
		if h := rawControl(t, a, trafficLine(otherNodeID(t), rs.URL, 1, 1)); h.reply["error"] == nil {
			t.Fatalf("a report for a node outside the view answered %v", h.reply)
		}
	}
	if n := a.d.traffic.Len(); n != 1 {
		t.Fatalf("%d entries after 300 reports naming unknown relays, want 1 (other relay)", n)
	}
	// The largest counts a report may carry add up without wrapping.
	for range 3 {
		if h := rawControl(t, a, trafficLine(self, rs.URL, json.Number("9007199254740991"), json.Number("9007199254740991"))); h.reply["t"] != "counted" {
			t.Fatalf("a report at the limit answered %v", h.reply)
		}
	}
	if tr := a.ls(t).Members[0].Traffic24h; tr == nil || tr.In != 3*(1<<53-1)+300 {
		t.Fatalf("traffic %+v after three reports at the limit", tr)
	}
}

// A relay removed from the node's list keeps its bytes in the window; pen ls and the dashboard show them as other relays.
func TestTrafficOverARelayNoLongerListedShowsAsOther(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	self := a.d.NodeID()
	for _, line := range []string{trafficLine(self, rs.URL, 10, 1), trafficLine(self, "https://x.example", 5, 2)} {
		if h := rawControl(t, a, line); h.reply["t"] != "counted" {
			t.Fatalf("%s answered %v", line, h.reply)
		}
	}
	a.d.cfgMu.Lock()
	a.d.cfg.SetRelays([]string{"https://now-listed.example"})
	a.d.cfgMu.Unlock()
	ls := a.ls(t)
	want := []RelayTraffic{{URL: "", In: 15, Out: 3}}
	if tr := ls.Members[0].Traffic24h; tr == nil || fmt.Sprint(tr.Relays) != fmt.Sprint(want) || fmt.Sprint(ls.Relays24h) != fmt.Sprint(want) {
		t.Fatalf("member %+v, relays %+v; want everything under other relays %+v", tr, ls.Relays24h, want)
	}
}

// A member revoked after it carried traffic keeps its bytes in pen ls (and the dashboard), not only in the relay total.
func TestARevokedMemberKeepsItsTrafficInLs(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	bm := memberNamed(t, a, "b")
	if h := rawControl(t, a, trafficLine(bm.NodeID, rs.URL, 10, 20)); h.reply["t"] != "counted" {
		t.Fatalf("report answered %v", h.reply)
	}
	var res struct{ Results []PushResult }
	if err := Call(a.st, Request{Op: "revoke", Subject: bm.SignPub}, &res); err != nil {
		t.Fatal(err)
	}
	_ = b
	var raw map[string]any
	if err := Call(a.st, Request{Op: "ls"}, &raw); err != nil {
		t.Fatal(err)
	}
	revoked, _ := raw["revoked"].([]any)
	if len(revoked) != 1 {
		t.Fatalf("revoked %v, want b", raw["revoked"])
	}
	tr, _ := revoked[0].(map[string]any)["traffic24h"].(map[string]any)
	if tr == nil || tr["in"] != float64(10) || tr["out"] != float64(20) {
		t.Fatalf("revoked b shows traffic %v, want in 10 out 20", tr)
	}
	if bs, _ := json.Marshal(a.d.dashState()); !strings.Contains(string(bs), `"revoked24h":{"in":10,"out":20`) {
		t.Fatalf("dashboard state %s has no revoked24h with b's bytes", bs)
	}
}
