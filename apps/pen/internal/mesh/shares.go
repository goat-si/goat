package mesh

import "sort"

// SetLineageShares switches the store to ADR-0026 shares; a mesh of the new epoch sets it.
func (s *Store) SetLineageShares() {
	s.mu.Lock()
	s.shares = true
	s.mu.Unlock()
}

// selectShares is the kept set of ADR-0026: a function of the candidates alone, so nodes that have
// exchanged their records keep the same ones whatever the arrival order.
func selectShares(cands []*Record) (map[string]*Record, map[string]intro) {
	keys, admits := introductions(cands, true)
	kept := make(map[string]*Record, len(admits))
	for _, r := range admits {
		kept[r.Hash] = r
	}
	type share struct {
		lineage int
		control bool
	}
	groups := map[share][]*Record{}
	for _, r := range cands {
		if r.B.Type == TypeFound || r.B.Type == TypeAdmit {
			continue
		}
		k, ok := keys[r.B.By]
		if !ok {
			continue
		}
		control := (r.B.Type == TypeRevoke || r.B.Type == TypeLock) && !r.Opaque
		if r.B.Type == TypeRevoke && !r.Opaque && !allIntroduced(keys, r.B.Subjects) {
			continue
		}
		key := share{k.lineage, control}
		groups[key] = append(groups[key], r)
	}
	for key, rs := range groups {
		sortByHash(rs)
		n := ShareOrdinary
		if key.control {
			n = ShareControl
		}
		for _, r := range rs[:min(n, len(rs))] {
			kept[r.Hash] = r
		}
	}
	return kept, keys
}

func allIntroduced(keys map[string]intro, subjects []string) bool {
	for _, k := range subjects {
		if _, ok := keys[k]; !ok {
			return false
		}
	}
	return true
}

// mergeShared stores recs under shares: a record's parents need not be present (a hash a kept record
// names without its record is bare), and the kept set is recomputed over the old and new records.
func (s *Store) mergeShared(recs []*Record) []*Record {
	cands := make([]*Record, 0, len(s.recs)+len(s.pool)+len(recs))
	for _, r := range s.recs {
		cands = append(cands, r)
	}
	for _, e := range s.pool {
		cands = append(cands, e.r)
	}
	seen := map[string]bool{}
	for _, r := range recs {
		if r == nil || s.recs[r.Hash] != nil || seen[r.Hash] || r.Verify() != nil || !s.belongs(r) {
			continue
		}
		if _, waiting := s.pool[r.Hash]; waiting {
			continue
		}
		seen[r.Hash] = true
		cands = append(cands, r)
	}
	if len(seen) == 0 {
		return nil
	}
	kept, keys := selectShares(cands)
	// A record whose signer is not introduced yet waits in the bounded pool for its admit; one left out
	// of a share is dropped.
	for _, r := range cands {
		if kept[r.Hash] != nil {
			s.poolRemove(r)
			continue
		}
		if _, ok := keys[r.B.By]; ok {
			s.poolRemove(r)
		} else if _, waiting := s.pool[r.Hash]; !waiting && r.B.By != s.self {
			s.poolAdd(r)
		}
	}
	var added []*Record
	for h, r := range kept {
		if s.recs[h] == nil {
			added = append(added, r)
		}
	}
	s.recs = kept
	s.bare = bareOf(kept)
	sort.Slice(added, func(i, j int) bool { return added[i].Hash < added[j].Hash })
	return added
}

// bareOf is the hashes the kept records name in prev without holding their record.
func bareOf(recs map[string]*Record) map[string]bool {
	bare := map[string]bool{}
	for _, r := range recs {
		for _, p := range r.B.Prev {
			if recs[p] == nil {
				bare[p] = true
			}
		}
	}
	return bare
}

// Bare returns the hashes kept without a record, sorted.
func (s *Store) Bare() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.bareList()
}

func (s *Store) bareList() []string {
	out := make([]string, 0, len(s.bare))
	for h := range s.bare {
		out = append(out, h)
	}
	sort.Strings(out)
	return out
}

func byHashOf(recs []*Record) map[string]*Record {
	m := make(map[string]*Record, len(recs))
	for _, r := range recs {
		m[r.Hash] = r
	}
	return m
}
