package mesh

import "bytes"

// MaxLineages is how many admission lineages share a mesh's record space (ADR-0026): the founder's,
// and one for each of its first 15 direct admits.
const MaxLineages = 16

// Lineages gives each record the admission lineage it is charged to (ADR-0026), worked out from the
// record's own past only, so every node that holds a record agrees on its lineage. The founder is
// lineage 0; the founder's k-th direct admit (k = 1 + the founder's admits in that admit's past) starts
// lineage k for k < MaxLineages, and later ones join lineage 0; a key admitted by a member joins that
// member's lineage. A record whose signer was not introduced in its past has no entry.
func Lineages(recs []*Record) map[string]int {
	byHash := make(map[string]*Record, len(recs))
	for _, r := range recs {
		byHash[r.Hash] = r
	}
	l := lineages{byHash: byHash, of: map[string]int{}, unknown: map[string]bool{}}
	for _, r := range recs {
		if r.B.Type == TypeFound && r.B.Card != nil && r.B.Card.C.SignPub == r.B.By {
			l.founder = r.B.By
		}
	}
	out := make(map[string]int, len(recs))
	for _, r := range recs {
		if k, ok := l.lineage(r); ok {
			out[r.Hash] = k
		}
	}
	return out
}

type lineages struct {
	byHash  map[string]*Record
	founder string
	of      map[string]int
	unknown map[string]bool
}

// lineage is the lineage of r's signer as of r's past.
func (l *lineages) lineage(r *Record) (int, bool) {
	if k, ok := l.of[r.Hash]; ok {
		return k, true
	}
	if l.unknown[r.Hash] {
		return 0, false
	}
	k, ok := l.compute(r)
	if ok {
		l.of[r.Hash] = k
	} else {
		l.unknown[r.Hash] = true
	}
	return k, ok
}

func (l *lineages) compute(r *Record) (int, bool) {
	if r.B.Type == TypeFound {
		return 0, r.B.By == l.founder
	}
	intro := l.introducer(r)
	if intro == nil {
		return 0, false
	}
	return l.started(intro)
}

// started is the lineage a found or admit puts its card subject in.
func (l *lineages) started(intro *Record) (int, bool) {
	if intro.B.Type == TypeFound {
		return 0, true
	}
	if intro.B.By != l.founder {
		return l.lineage(intro)
	}
	k := 1
	l.walkPast(intro, func(p *Record) {
		if p.B.Type == TypeAdmit && p.B.By == l.founder {
			k++
		}
	})
	if k >= MaxLineages {
		return 0, true
	}
	return k, true
}

// introducer is the found or admit in r's past whose card subject signs r; of several admits of the
// same key, the one with the smallest raw hash.
func (l *lineages) introducer(r *Record) *Record {
	var best *Record
	l.walkPast(r, func(p *Record) {
		if p.B.Card == nil || p.B.Card.C.SignPub != r.B.By {
			return
		}
		if p.B.Type != TypeFound && p.B.Type != TypeAdmit {
			return
		}
		if best == nil || bytes.Compare(p.Sum[:], best.Sum[:]) < 0 {
			best = p
		}
	})
	return best
}

// walkPast calls f for each record in r's past (not r itself) that the set holds.
func (l *lineages) walkPast(r *Record, f func(*Record)) {
	seen := map[string]bool{}
	queue := append([]string(nil), r.B.Prev...)
	for len(queue) > 0 {
		h := queue[0]
		queue = queue[1:]
		if seen[h] {
			continue
		}
		seen[h] = true
		p := l.byHash[h]
		if p == nil {
			continue
		}
		f(p)
		queue = append(queue, p.B.Prev...)
	}
}
