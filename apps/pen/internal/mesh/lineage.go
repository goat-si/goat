package mesh

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"sort"
)

// Shares of ADR-0026. Lineage 0 is the founder alone; each machine the founder admits starts one of
// lineages 1 to MaxLineages-1, chosen by its invite nonce, and every key admitted below it joins that
// lineage. Each lineage keeps ShareOrdinary records of other types, ShareLocks lock records,
// ShareAdmits admits signed by keys other than the founder and ShareRevokes revoke places (one per
// subject and compromised flag, shares.go); the founder's own admits share FounderAdmits places.
// 16 x 248 + 64 + the found record stay within MaxRecords, so a set fits a have line.
const (
	MaxLineages   = 16
	ShareOrdinary = 160
	ShareLocks    = 16
	ShareAdmits   = 16
	ShareRevokes  = 56
	FounderAdmits = 64
)

// A full shared set (every share, the founder's admits and the found record) fits MaxRecords: the
// array length is negative, and the build fails, if a share grows past it.
var _ [MaxRecords - MaxLineages*(ShareOrdinary+ShareLocks+ShareAdmits+ShareRevokes) - FounderAdmits - 1]struct{}

// intro is how a key was introduced: its lineage and admission depth (the founder is 0, 0).
type intro struct {
	lineage, depth int
}

// introductions works out, from the found and admit records of recs, which keys are introduced and in
// which lineage (ADR-0026 "Introducer", "Depth", "Lineage"). It reads no record's past, and a key's
// lineage depends only on its introducing admit and the lineage of that admit's signer. With limit set
// it also applies the founder-admit and per-lineage admit shares and returns the admits it kept. The
// founder is the signer of meshID's own found record; any other found record is ignored.
func introductions(meshID string, recs []*Record, limit bool) (map[string]intro, []*Record) {
	var founder string
	var kept []*Record
	for _, r := range recs {
		if r.B.Type == TypeFound && r.B.Card != nil && r.B.Card.C.SignPub == r.B.By && MeshIDOf(r) == meshID {
			founder = r.B.By
			kept = append(kept, r)
			break
		}
	}
	keys := map[string]intro{}
	if founder == "" {
		return keys, kept
	}
	keys[founder] = intro{0, 0}
	var fa []*Record
	bySigner := map[string][]*Record{}
	for _, r := range recs {
		if r.B.Type != TypeAdmit || r.B.Card == nil {
			continue
		}
		if r.B.By == founder {
			fa = append(fa, r)
		} else {
			bySigner[r.B.By] = append(bySigner[r.B.By], r)
		}
	}
	// The founder's admits keep their places by its counter, so a later admit never displaces one.
	sort.Slice(fa, func(i, j int) bool {
		if fa[i].B.N != fa[j].B.N {
			return fa[i].B.N < fa[j].B.N
		}
		return bytes.Compare(fa[i].Sum[:], fa[j].Sum[:]) < 0
	})
	if limit && len(fa) > FounderAdmits {
		fa = fa[:FounderAdmits]
	}
	kept = append(kept, fa...)
	introduce(keys, fa, 1, func(r *Record) int { return nonceLineage(r.B.Card.C.Nonce) })
	used := map[int]int{}
	for depth := 2; ; depth++ {
		var level []*Record
		for signer, rs := range bySigner {
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
		introduce(keys, chosen, depth, func(r *Record) int { return keys[r.B.By].lineage })
	}
	return keys, kept
}

// introduce makes each subject of admits that has no introduction yet introduced at depth: a key's
// introducer is its admit at the shallowest depth, of several there the one with the smallest hash.
func introduce(keys map[string]intro, admits []*Record, depth int, lineageOf func(*Record) int) {
	byHash := append([]*Record(nil), admits...)
	sortByHash(byHash)
	for _, r := range byHash {
		sub := r.B.Card.C.SignPub
		if _, ok := keys[sub]; ok {
			continue
		}
		keys[sub] = intro{lineageOf(r), depth}
	}
}

// nonceLineage is the lineage a founder's admit starts: fixed by the invite nonce the founder chose,
// so it does not depend on any other record.
func nonceLineage(nonce string) int {
	sum := sha256.Sum256([]byte(nonce))
	return 1 + int(binary.BigEndian.Uint16(sum[:2])%(MaxLineages-1))
}

// Lineages gives each record of recs whose signer is introduced in meshID the lineage it is charged to.
func Lineages(meshID string, recs []*Record) map[string]int {
	keys, _ := introductions(meshID, recs, false)
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
