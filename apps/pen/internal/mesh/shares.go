package mesh

import (
	"bytes"
	"slices"
	"sort"
)

// learnVersion takes the mesh's version from its found record among recs, and switches a mesh of the
// shared epoch to shares.
func (s *Store) learnVersion(recs []*Record) {
	for _, r := range recs {
		if r != nil && r.Verify() == nil && r.B.Type == TypeFound && MeshIDOf(r) == s.MeshID {
			s.version = r.B.V
			s.shares = s.shares || r.B.V == EpochShared
			// Records pooled before the version was known may be of the other one.
			for _, e := range s.pool {
				if !s.belongs(e.r) {
					s.poolRemove(e.r)
				}
			}
			return
		}
	}
}

// Shared reports whether the store follows ADR-0026 shares (a mesh of the shared epoch).
func (s *Store) Shared() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.shares
}

// SetLineageShares switches the store to ADR-0026 shares; a mesh of the new epoch sets it.
func (s *Store) SetLineageShares() {
	s.mu.Lock()
	s.shares = true
	s.mu.Unlock()
}

// selectShares is the kept set of ADR-0026: a function of the mesh id and the candidates alone, so nodes
// that have exchanged their records keep the same ones whatever the arrival order.
func selectShares(meshID string, cands []*Record) (map[string]*Record, map[string]intro) {
	keys, admits := introductions(meshID, cands, true)
	kept := make(map[string]*Record, len(admits))
	for _, r := range admits {
		kept[r.Hash] = r
	}
	type share struct {
		lineage int
		lock    bool
	}
	// A lineage's revoke places hold one revoke per (subject, compromised), the smallest of each, and
	// of those the ShareRevokes smallest: a lineage spends only its own places.
	type revokeSlot struct {
		subject     string
		lineage     int
		compromised bool
	}
	groups := map[share][]*Record{}
	revokes := map[revokeSlot]*Record{}
	for _, r := range cands {
		// An admit this version cannot read introduces nobody; it is an ordinary record of its signer.
		if (r.B.Type == TypeFound || r.B.Type == TypeAdmit) && !r.Opaque {
			continue
		}
		k, ok := keys[r.B.By]
		if !ok {
			continue
		}
		if r.B.Type == TypeRevoke && !r.Opaque {
			// A subject need not be introduced yet: the revoke spends only its signer's lineage places, so
			// it is kept whatever arrives first.
			for _, sub := range r.B.Subjects {
				slot := revokeSlot{sub, k.lineage, r.B.Compromised != nil && *r.B.Compromised}
				if best := revokes[slot]; best == nil || bytes.Compare(r.Sum[:], best.Sum[:]) < 0 {
					revokes[slot] = r
				}
			}
			continue
		}
		key := share{k.lineage, r.B.Type == TypeLock && !r.Opaque}
		groups[key] = append(groups[key], r)
	}
	byLineage := map[int][]*Record{}
	for slot, r := range revokes {
		if !slices.Contains(byLineage[slot.lineage], r) {
			byLineage[slot.lineage] = append(byLineage[slot.lineage], r)
		}
	}
	for _, rs := range byLineage {
		sortByHash(rs)
		for _, r := range rs[:min(ShareRevokes, len(rs))] {
			kept[r.Hash] = r
		}
	}
	for key, rs := range groups {
		sortByHash(rs)
		n := ShareOrdinary
		if key.lock {
			n = ShareLocks
		}
		for _, r := range rs[:min(n, len(rs))] {
			kept[r.Hash] = r
		}
	}
	return kept, keys
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
	kept, keys := selectShares(s.MeshID, cands)
	// A record whose signer is not introduced yet waits in the bounded pool for its admit; one left out
	// of a share is dropped. Hash order makes one merge's pool evictions the same everywhere.
	sortByHash(cands)
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
