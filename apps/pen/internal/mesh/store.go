package mesh

import (
	"errors"
	"os"
	"sort"
	"sync"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

const (
	// MaxRecords caps a mesh's record set.
	MaxRecords = 4096
	// MaxPool caps records waiting for their prev.
	MaxPool = 256
)

// ErrFull is returned when a merge would take the set past MaxRecords.
var ErrFull = errors.New("mesh: record set is full (4096)")

// Store is a node's record set for one mesh. It is safe for concurrent use.
type Store struct {
	st     *state.Store
	MeshID string

	mu    sync.Mutex
	recs  map[string]*Record
	pool  map[string]*Record
	selfN uint64
	view  *View
}

type storeFile struct {
	MeshID  string    `json:"meshId"`
	Records []*Record `json:"records"`
	Pool    []*Record `json:"pool"`
	SelfN   uint64    `json:"selfN"`
}

// NewStore is an empty set for meshID; st may be nil for an unpersisted set.
func NewStore(st *state.Store, meshID string) *Store {
	return &Store{st: st, MeshID: meshID, recs: map[string]*Record{}, pool: map[string]*Record{}}
}

// Load reads mesh.json, re-verifying every record; os.ErrNotExist when there is no mesh.
func Load(st *state.Store) (*Store, error) {
	var f storeFile
	ok, err := st.ReadJSON("mesh.json", &f)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, os.ErrNotExist
	}
	s := NewStore(st, f.MeshID)
	if _, err := s.merge(append(f.Records, f.Pool...)); err != nil && !errors.Is(err, ErrFull) {
		return nil, err
	}
	s.selfN = f.SelfN
	s.view = nil
	return s, nil
}

// Found creates a new mesh with id as its only member and persists it when st is set.
func Found(st *state.Store, id *ident.Identity, name string, at int64) (*Store, error) {
	nonce, err := randomNonce()
	if err != nil {
		return nil, err
	}
	card, err := MakeCard(id, foundMesh, foundMesh, nonce, name)
	if err != nil {
		return nil, err
	}
	r, err := Sign(id, foundMesh, TypeFound, 1, nil, at, Fields{Card: card})
	if err != nil {
		return nil, err
	}
	s := NewStore(st, MeshIDOf(r))
	if _, err := s.Merge([]*Record{r}); err != nil {
		return nil, err
	}
	s.selfN = 1
	return s, s.Save()
}

// FromJoin builds a store from a joined set after checking the founding record names meshID.
func FromJoin(st *state.Store, meshID string, recs []*Record) (*Store, error) {
	s := NewStore(st, meshID)
	if _, err := s.Merge(recs); err != nil {
		return nil, err
	}
	found := false
	for _, r := range s.recs {
		if r.B.Type == TypeFound && MeshIDOf(r) == meshID {
			found = true
		}
	}
	if !found {
		return nil, errors.New("mesh: joined set has no founding record for its mesh id")
	}
	return s, nil
}

func (s *Store) belongs(r *Record) bool {
	if r.B.Type == TypeFound {
		return MeshIDOf(r) == s.MeshID
	}
	return r.B.Mesh == s.MeshID
}

// Merge verifies and stores records (contract "Records"): unverifiable or foreign ones are dropped,
// ones whose prev is incomplete wait in the pool. It returns the records newly stored.
func (s *Store) Merge(recs []*Record) ([]*Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	added, err := s.merge(recs)
	if len(added) > 0 {
		s.view = nil
	}
	return added, err
}

func (s *Store) merge(recs []*Record) ([]*Record, error) {
	for _, r := range recs {
		if r == nil || r.Verify() != nil || !s.belongs(r) {
			continue
		}
		if s.recs[r.Hash] != nil || s.pool[r.Hash] != nil {
			continue
		}
		if len(s.pool) >= MaxPool {
			continue
		}
		s.pool[r.Hash] = r
	}
	var added []*Record
	for progress := true; progress; {
		progress = false
		ready := make([]*Record, 0)
		for _, r := range s.pool {
			ok := true
			for _, p := range r.B.Prev {
				if s.recs[p] == nil {
					ok = false
					break
				}
			}
			if ok {
				ready = append(ready, r)
			}
		}
		sort.Slice(ready, func(i, j int) bool { return ready[i].Hash < ready[j].Hash })
		for _, r := range ready {
			if len(s.recs) >= MaxRecords {
				return added, ErrFull
			}
			delete(s.pool, r.Hash)
			s.recs[r.Hash] = r
			added = append(added, r)
			progress = true
		}
	}
	return added, nil
}

// Save writes mesh.json under the state lock (no-op without a state directory).
func (s *Store) Save() error {
	if s.st == nil {
		return nil
	}
	s.mu.Lock()
	f := storeFile{MeshID: s.MeshID, Records: CanonicalOrder(s.all()), SelfN: s.selfN, Pool: []*Record{}}
	for _, r := range s.pool {
		f.Pool = append(f.Pool, r)
	}
	s.mu.Unlock()
	sort.Slice(f.Pool, func(i, j int) bool { return f.Pool[i].Hash < f.Pool[j].Hash })
	unlock, err := s.st.Lock()
	if err != nil {
		return err
	}
	defer unlock()
	return s.st.WriteJSON("mesh.json", f, 0o600)
}

func (s *Store) all() []*Record {
	out := make([]*Record, 0, len(s.recs))
	for _, r := range s.recs {
		out = append(out, r)
	}
	return out
}

// Records returns the stored set in canonical order.
func (s *Store) Records() []*Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	return CanonicalOrder(s.all())
}

// Has reports whether hash is stored.
func (s *Store) Has(hash string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.recs[hash] != nil
}

// Len is the number of stored records.
func (s *Store) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.recs)
}

// View replays the set (cached until the next change).
func (s *Store) View() *View {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.view == nil {
		s.view = Compute(s.MeshID, s.all())
	}
	return s.view
}

// heads are the set's tips (records no stored record names in prev), by hash.
func (s *Store) heads() []string {
	referenced := map[string]bool{}
	for _, r := range s.recs {
		for _, p := range r.B.Prev {
			referenced[p] = true
		}
	}
	var out []string
	for h := range s.recs {
		if !referenced[h] {
			out = append(out, h)
		}
	}
	sort.Strings(out)
	return out
}

// choosePrev picks up to 64 heads, keeping one whose past holds the signer's latest record.
func (s *Store) choosePrev(own string) []string {
	heads := s.heads()
	if len(heads) <= maxPrev || own == "" {
		if len(heads) > maxPrev {
			heads = heads[:maxPrev]
		}
		return heads
	}
	children := map[string][]string{}
	for _, r := range s.recs {
		for _, p := range r.B.Prev {
			children[p] = append(children[p], r.Hash)
		}
	}
	isHead := map[string]bool{}
	for _, h := range heads {
		isHead[h] = true
	}
	keep := ""
	queue, seen := []string{own}, map[string]bool{own: true}
	for len(queue) > 0 && keep == "" {
		x := queue[0]
		queue = queue[1:]
		if isHead[x] {
			keep = x
			break
		}
		for _, c := range children[x] {
			if !seen[c] {
				seen[c] = true
				queue = append(queue, c)
			}
		}
	}
	out := []string{keep}
	for _, h := range heads {
		if h != keep && len(out) < maxPrev {
			out = append(out, h)
		}
	}
	sort.Strings(out)
	return out
}

// Append signs the signer's next record over the current heads, stores it and saves.
func (s *Store) Append(id *ident.Identity, typ string, at int64, f Fields) (*Record, error) {
	s.mu.Lock()
	by := ident.B64.EncodeToString(id.SignPub)
	n, own := s.selfN, ""
	var ownN uint64
	for _, r := range s.recs {
		if r.B.By == by && r.B.N >= ownN {
			if r.B.N > ownN || r.Hash < own {
				own = r.Hash
			}
			ownN = r.B.N
		}
	}
	n = max(n, ownN) + 1
	r, err := Sign(id, s.MeshID, typ, n, s.choosePrev(own), at, f)
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	added, err := s.merge([]*Record{r})
	if err == nil && len(added) != 1 {
		err = errors.New("mesh: own record was not stored")
	}
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	s.selfN = n
	s.view = nil
	s.mu.Unlock()
	return r, s.Save()
}

