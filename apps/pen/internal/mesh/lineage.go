package mesh

import (
	"bytes"
	"sort"
)

// Shares of ADR-0026: MaxLineages lineages, each keeping ShareOrdinary records of other types,
// ShareControl revoke or lock records and ShareAdmits admits signed by keys other than the founder;
// the founder's own admits share FounderAdmits places. 16 x 252 + 64 = MaxRecords.
const (
	MaxLineages   = 16
	ShareOrdinary = 220
	ShareControl  = 16
	ShareAdmits   = 16
	FounderAdmits = 64
)

// intro is how a key was introduced: its lineage and admission depth (the founder is 0, 0).
type intro struct {
	lineage, depth int
}

// introductions works out, from the found and admit records of recs, which keys are introduced and in
// which lineage (ADR-0026 "Introducer", "Depth", "Lineage"). It reads no record's past. With limit set
// it also applies the founder-admit and per-lineage admit shares and returns the admits it kept.
func introductions(recs []*Record, limit bool) (map[string]intro, []*Record) {
	var founder string
	var kept []*Record
	for _, r := range recs {
		if r.B.Type == TypeFound && r.B.Card != nil && r.B.Card.C.SignPub == r.B.By {
			founder = r.B.By
			kept = append(kept, r)
		}
	}
	keys := map[string]intro{}
	if founder == "" {
		return keys, kept
	}
	keys[founder] = intro{0, 0}
	var fa []*Record
	byDepthSigner := map[string][]*Record{}
	for _, r := range recs {
		if r.B.Type != TypeAdmit || r.B.Card == nil {
			continue
		}
		if r.B.By == founder {
			fa = append(fa, r)
		} else {
			byDepthSigner[r.B.By] = append(byDepthSigner[r.B.By], r)
		}
	}
	sortByHash(fa)
	if limit && len(fa) > FounderAdmits {
		fa = fa[:FounderAdmits]
	}
	kept = append(kept, fa...)
	ranked := append([]*Record(nil), fa...)
	sort.Slice(ranked, func(i, j int) bool {
		if ranked[i].B.N != ranked[j].B.N {
			return ranked[i].B.N < ranked[j].B.N
		}
		return bytes.Compare(ranked[i].Sum[:], ranked[j].Sum[:]) < 0
	})
	rank := map[string]int{}
	for i, r := range ranked {
		rank[r.Hash] = i + 1
	}
	// fa is in hash order, so the first admit naming a subject is its introducer.
	for _, r := range fa {
		sub := r.B.Card.C.SignPub
		if _, ok := keys[sub]; ok {
			continue
		}
		l := rank[r.Hash]
		if l >= MaxLineages {
			l = 0
		}
		keys[sub] = intro{l, 1}
	}
	used := map[int]int{}
	for depth := 2; ; depth++ {
		var level []*Record
		for signer, rs := range byDepthSigner {
			if k, ok := keys[signer]; ok && k.depth == depth-1 {
				level = append(level, rs...)
			}
		}
		if len(level) == 0 {
			break
		}
		sortByHash(level)
		var chosen []*Record
		for _, r := range level {
			l := keys[r.B.By].lineage
			if limit && used[l] >= ShareAdmits {
				continue
			}
			used[l]++
			chosen = append(chosen, r)
		}
		kept = append(kept, chosen...)
		for _, r := range chosen {
			sub := r.B.Card.C.SignPub
			if _, ok := keys[sub]; !ok {
				keys[sub] = intro{keys[r.B.By].lineage, depth}
			}
		}
	}
	return keys, kept
}

// Lineages gives each record of recs whose signer is introduced the lineage it is charged to.
func Lineages(recs []*Record) map[string]int {
	keys, _ := introductions(recs, false)
	out := map[string]int{}
	for _, r := range recs {
		if k, ok := keys[r.B.By]; ok {
			out[r.Hash] = k.lineage
		}
	}
	return out
}

func sortByHash(rs []*Record) {
	sort.Slice(rs, func(i, j int) bool { return bytes.Compare(rs[i].Sum[:], rs[j].Sum[:]) < 0 })
}
