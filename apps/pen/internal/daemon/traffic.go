package daemon

import (
	"cmp"
	"encoding/json"
	"errors"
	"slices"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/session"
	"github.com/goat-si/goat/apps/pen/internal/stream"
	"github.com/goat-si/goat/apps/pen/internal/strictjson"
	"github.com/goat-si/goat/apps/pen/internal/traffic"
)

// TrafficReport is control op traffic.report: stream bytes a pen pipe or pen forward session of this machine
// carried with member Node over Relay since its last report (contract "Traffic counters").
type TrafficReport struct {
	Op    string `json:"op"`
	Node  string `json:"node"`
	Relay string `json:"relay"`
	In    uint64 `json:"in"`
	Out   uint64 `json:"out"`
}

const (
	// MaxTrafficCount is the largest in or out one report carries: 2^53-1, exact as a JSON number anywhere.
	MaxTrafficCount = 1<<53 - 1
	maxTrafficRelay = 512
)

// RelayTraffic is the bytes of the last 24 hours over one relay; URL "" stands for relays not in this node's list.
type RelayTraffic struct {
	URL string `json:"url"`
	In  uint64 `json:"in"`
	Out uint64 `json:"out"`
}

// MemberTraffic is the bytes of the last 24 hours with one member: In from it, Out to it.
type MemberTraffic struct {
	In     uint64         `json:"in"`
	Out    uint64         `json:"out"`
	Relays []RelayTraffic `json:"relays"`
}

func (t *MemberTraffic) add(in, out uint64) {
	t.In, t.Out = traffic.AddSat(t.In, in), traffic.AddSat(t.Out, out)
}

var errBadTraffic = errors.New("bad traffic report")

// trafficWindow lets daemon.go hold the window without importing traffic.
type trafficWindow = traffic.Window

var newTrafficWindow = traffic.NewWindow

// reportTraffic adds one traffic.report line to the window. A refusal changes nothing. Only a current or revoked
// member of the view is counted, and a relay this node does not list counts as "", so the keys a client can
// create are bounded by the view and the relay list, and the window's cap bounds them again.
func (d *Daemon) reportTraffic(line []byte) (any, error) {
	var r TrafficReport
	if err := strictjson.Unmarshal(line, &r); err != nil || !everyMemberSet(line) {
		return nil, errBadTraffic
	}
	if r.In > MaxTrafficCount || r.Out > MaxTrafficCount || len(r.Relay) > maxTrafficRelay || !ident.ValidNodeID(r.Node) {
		return nil, errBadTraffic
	}
	v := d.view()
	if _, ok := v.MemberByNodeID(r.Node); !ok {
		if _, ok := v.RevokedByNodeID(r.Node); !ok {
			return nil, errors.New("not a member of this node's mesh")
		}
	}
	relay := r.Relay
	if !slices.Contains(d.relays(), relay) {
		relay = ""
	}
	if err := d.traffic.Add(r.Node, relay, r.In, r.Out); err != nil {
		return nil, err
	}
	return map[string]string{"t": "counted"}, nil
}

// everyMemberSet reports whether a report names all five members, none of them null (strictjson refuses unknown and
// duplicate members, and encoding/json reads a null or a missing member as zero).
func everyMemberSet(line []byte) bool {
	var m map[string]json.RawMessage
	if json.Unmarshal(line, &m) != nil || len(m) != len(strictjson.Names(&TrafficReport{})) {
		return false
	}
	for _, v := range m {
		if string(v) == "null" {
			return false
		}
	}
	return true
}

// meterAccepted counts an accepted session's stream bytes straight into the window.
func (d *Daemon) meterAccepted(sec *session.Secure, relayURL string) stream.Link {
	m, ok := d.view().MemberByNoise(sec.RemoteStatic)
	if !ok {
		return sec
	}
	return traffic.Meter(sec, func(in, out uint64) { _ = d.traffic.Add(m.NodeID, relayURL, in, out) })
}

// trafficTotals groups the window by member and by relay; since is where the totals start (ms). A relay no longer in
// this node's list shows as "" (other relays), like one reported that it never listed.
func (d *Daemon) trafficTotals() (members map[string]*MemberTraffic, relays []RelayTraffic, since int64) {
	totals := d.traffic.Totals()
	if len(totals) == 0 {
		return nil, nil, 0
	}
	listed := d.relays()
	members = map[string]*MemberTraffic{}
	for _, t := range totals {
		url := t.Relay
		if !slices.Contains(listed, url) {
			url = ""
		}
		m := members[t.Member]
		if m == nil {
			m = &MemberTraffic{}
			members[t.Member] = m
		}
		m.In, m.Out = traffic.AddSat(m.In, t.In), traffic.AddSat(m.Out, t.Out)
		m.Relays = addRelay(m.Relays, url, t.In, t.Out)
		relays = addRelay(relays, url, t.In, t.Out)
	}
	byURL := func(a, b RelayTraffic) int { return cmp.Compare(a.URL, b.URL) }
	for _, m := range members {
		slices.SortFunc(m.Relays, byURL)
	}
	slices.SortFunc(relays, byURL)
	return members, relays, d.traffic.Since().UnixMilli()
}

func addRelay(rs []RelayTraffic, url string, in, out uint64) []RelayTraffic {
	for i := range rs {
		if rs[i].URL == url {
			rs[i].In, rs[i].Out = traffic.AddSat(rs[i].In, in), traffic.AddSat(rs[i].Out, out)
			return rs
		}
	}
	return append(rs, RelayTraffic{URL: url, In: in, Out: out})
}
