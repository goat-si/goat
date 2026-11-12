package daemon

import (
	"cmp"
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

var errBadTraffic = errors.New("bad traffic report")

// reportTraffic adds one traffic.report line to the window. A refusal changes nothing. Only a current or revoked
// member of the view is counted, and a relay this node does not list counts as "", so the keys a client can
// create are bounded by the view and the relay list, and the window's cap bounds them again.
func (d *Daemon) reportTraffic(line []byte) (any, error) {
	var r TrafficReport
	if err := strictjson.Unmarshal(line, &r); err != nil {
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

// meterAccepted counts an accepted session's stream bytes straight into the window.
func (d *Daemon) meterAccepted(sec *session.Secure, relayURL string) stream.Link {
	m, ok := d.view().MemberByNoise(sec.RemoteStatic)
	if !ok {
		return sec
	}
	return traffic.Meter(sec, func(in, out uint64) { _ = d.traffic.Add(m.NodeID, relayURL, in, out) })
}

// trafficTotals groups the window by member and by relay; since is where the totals start (ms).
func (d *Daemon) trafficTotals() (members map[string]*MemberTraffic, relays []RelayTraffic, since int64) {
	totals := d.traffic.Totals()
	if len(totals) == 0 {
		return nil, nil, 0
	}
	members = map[string]*MemberTraffic{}
	byRelay := map[string]*RelayTraffic{}
	for _, t := range totals {
		m := members[t.Member]
		if m == nil {
			m = &MemberTraffic{}
			members[t.Member] = m
		}
		m.In, m.Out = traffic.AddSat(m.In, t.In), traffic.AddSat(m.Out, t.Out)
		m.Relays = append(m.Relays, RelayTraffic{URL: t.Relay, In: t.In, Out: t.Out})
		r := byRelay[t.Relay]
		if r == nil {
			r = &RelayTraffic{URL: t.Relay}
			byRelay[t.Relay] = r
		}
		r.In, r.Out = traffic.AddSat(r.In, t.In), traffic.AddSat(r.Out, t.Out)
	}
	for _, r := range byRelay {
		relays = append(relays, *r)
	}
	slices.SortFunc(relays, func(a, b RelayTraffic) int { return cmp.Compare(a.URL, b.URL) })
	return members, relays, d.traffic.Since().UnixMilli()
}
