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
	// MaxOrdinary is where records other than revokes stop, keeping room for revokes so a full
	// set can still revoke and every set fits a 4096-hash have.
	MaxOrdinary = 3840
	// MaxPool caps records waiting for their prev; MaxPoolPerSigner caps one signer's share.
	MaxPool          = 256
	MaxPoolPerSigner = 16
)

// ErrFull is returned when a record does not fit under the caps.
var ErrFull = errors.New("mesh: record set is full (3840 records, 4096 with revokes)")

// Store is a node's record set for one mesh. It is safe for concurrent use.
type Store struct {
	st     *state.Store
	MeshID string

	mu    sync.Mutex
	recs  map[string]*Record
	selfN uint64
	view  *View
	// self is this node's signPub; its own records never wait in the pool.
	self string
	// uncapped is set while reloading the node's own saved set.
	uncapped bool

	// pool holds records whose prev is incomplete, in memory only.
	pool    map[string]pooled
	poolSeq uint64
	poolBy  map[string]int
	// reach[k] holds stored records whose past (or self) has a found or admit introducing k.
	reach map[string]map[string]bool
}

type pooled struct {
	r   *Record
	seq uint64
}

type storeFile struct {
	MeshID  string    `json:"meshId"`
	Records []*Record `json:"records"`
	Pool    []*Record `json:"pool"`
	SelfN   uint64    `json:"selfN"`
}

// NewStore is an empty set for meshID; st may be nil for an unpersisted set.
func NewStore(st *state.Store, meshID string) *Store {
	return &Store{st: st, MeshID: meshID, recs: map[string]*Record{}, pool: map[string]pooled{},
		poolBy: map[string]int{}, reach: map[string]map[string]bool{}}
}

// SetSelf names this node's signing key (base64url), whose records are never pooled.
func (s *Store) SetSelf(signPub string) {
	s.mu.Lock()
	s.self = signPub
	s.mu.Unlock()
}

// Load reads mesh.json, re-verifying every record; os.ErrNotExist when there is no mesh.
func Load(st *state.Store) (*Store, error) {
	return LoadFile(st, "mesh.json")
}

// LoadFile reads a saved set from name in st; the store saves to mesh.json.
func LoadFile(st *state.Store, name string) (*Store, error) {
	var f storeFile
	ok, err := st.ReadJSON(name, &f)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, os.ErrNotExist
	}
	s := NewStore(st, f.MeshID)
	// The node's own saved set reloads whole: caps apply to records arriving from peers.
	s.uncapped = true
	_, err = s.merge(f.Records)
	s.uncapped = false
	if err != nil {
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
	s.self = ident.B64.EncodeToString(id.SignPub)
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

// Merge verifies and stores records (contract "Records"). Unverifiable or foreign records are
// dropped; a record whose prev is all present is stored only if its signer was introduced (found or
// admit) in its past; one whose prev is incomplete waits in the pool. It returns the stored records.
func (s *Store) Merge(recs []*Record) ([]*Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	added, err := s.merge(recs)
	if len(added) > 0 {
		s.view = nil
	}
	return added, err
}

func (s *Store) prevPresent(r *Record) bool {
	for _, p := range r.B.Prev {
		if s.recs[p] == nil {
			return false
		}
	}
	return true
}

func (s *Store) merge(recs []*Record) ([]*Record, error) {
	var added []*Record
	var full error
	store := func(r *Record) {
		ok, err := s.store(r)
		if err != nil {
			full = err
		}
		if ok {
			added = append(added, r)
		}
	}
	for _, r := range recs {
		if r == nil || r.Verify() != nil || !s.belongs(r) {
			continue
		}
		if s.recs[r.Hash] != nil {
			continue
		}
		if _, waiting := s.pool[r.Hash]; waiting {
			continue
		}
		if s.prevPresent(r) {
			store(r)
		} else if r.B.By != s.self {
			s.poolAdd(r)
		}
	}
	for progress := len(added) > 0; progress; {
		progress = false
		var ready []pooled
		for _, e := range s.pool {
			if s.prevPresent(e.r) {
				ready = append(ready, e)
			}
		}
		sort.Slice(ready, func(i, j int) bool { return ready[i].seq < ready[j].seq })
		for _, e := range ready {
			s.poolRemove(e.r)
			before := len(added)
			store(e.r)
			progress = progress || len(added) > before
		}
	}
	return added, full
}

// store keeps a record whose prev is present, if its signer was introduced in its past and the caps
// allow it: other records stop at 3840, revokes at 4096.
func (s *Store) store(r *Record) (bool, error) {
	revoke := r.B.Type == TypeRevoke && !r.Opaque
	if !s.uncapped && (len(s.recs) >= MaxRecords || !revoke && len(s.recs) >= MaxOrdinary) {
		return false, ErrFull
	}
	if !s.introduced(r) {
		return false, nil
	}
	if revoke {
		for _, k := range r.B.Subjects {
			if !s.introducedIn(k, r.B.Prev) {
				return false, nil
			}
		}
	}
	s.recs[r.Hash] = r
	s.mark(r.B.By, r.Hash)
	if (r.B.Type == TypeFound || r.B.Type == TypeAdmit) && r.B.Card != nil {
		s.mark(r.B.Card.C.SignPub, r.Hash)
	}
	return true, nil
}

func (s *Store) mark(key, hash string) {
	m := s.reach[key]
	if m == nil {
		m = map[string]bool{}
		s.reach[key] = m
	}
	m[hash] = true
}

// introduced reports whether a found or admit whose card subject is r's signer is in r's past.
func (s *Store) introduced(r *Record) bool {
	if r.B.Type == TypeFound {
		return r.B.Card != nil && r.B.Card.C.SignPub == r.B.By
	}
	return s.introducedIn(r.B.By, r.B.Prev)
}

// introducedIn reports whether a found or admit whose card subject is key is in the past named by prev.
func (s *Store) introducedIn(key string, prev []string) bool {
	reach := s.reach[key]
	if reach == nil {
		return false
	}
	queue := append([]string(nil), prev...)
	seen := map[string]bool{}
	for len(queue) > 0 {
		h := queue[0]
		queue = queue[1:]
		if seen[h] {
			continue
		}
		seen[h] = true
		if reach[h] {
			return true
		}
		if p := s.recs[h]; p != nil {
			queue = append(queue, p.B.Prev...)
		}
	}
	return false
}

// poolAdd keeps an orphan, dropping the signer's oldest past 16 and the oldest overall past 256.
func (s *Store) poolAdd(r *Record) {
	if s.poolBy[r.B.By] >= MaxPoolPerSigner {
		s.poolRemove(s.oldest(r.B.By))
	}
	if len(s.pool) >= MaxPool {
		s.poolRemove(s.oldest(""))
	}
	s.poolSeq++
	s.pool[r.Hash] = pooled{r: r, seq: s.poolSeq}
	s.poolBy[r.B.By]++
}

func (s *Store) oldest(by string) *Record {
	var best *pooled
	for _, e := range s.pool {
		if by != "" && e.r.B.By != by {
			continue
		}
		if best == nil || e.seq < best.seq {
			e := e
			best = &e
		}
	}
	return best.r
}

func (s *Store) poolRemove(r *Record) {
	if _, ok := s.pool[r.Hash]; !ok {
		return
	}
	delete(s.pool, r.Hash)
	if s.poolBy[r.B.By]--; s.poolBy[r.B.By] <= 0 {
		delete(s.poolBy, r.B.By)
	}
}

// Save writes mesh.json under the state lock (no-op without a state directory).
func (s *Store) Save() error {
	if s.st == nil {
		return nil
	}
	return s.SaveFile(s.st, "mesh.json")
}

// SaveFile writes the set to name in st under the state lock.
func (s *Store) SaveFile(st *state.Store, name string) error {
	s.mu.Lock()
	// The pool is not persisted (contract "Records").
	f := storeFile{MeshID: s.MeshID, Records: CanonicalOrder(s.all()), SelfN: s.selfN, Pool: []*Record{}}
	s.mu.Unlock()
	unlock, err := st.Lock()
	if err != nil {
		return err
	}
	defer unlock()
	return st.WriteJSON(name, f, 0o600)
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

// choosePrev picks up to limit heads, keeping one whose past holds the signer's latest record.
func (s *Store) choosePrev(own string, limit int) []string {
	heads := s.heads()
	if len(heads) <= limit || own == "" {
		if len(heads) > limit {
			heads = heads[:limit]
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
		if h != keep && len(out) < limit {
			out = append(out, h)
		}
	}
	sort.Strings(out)
	return out
}

// Append signs the signer's next record over the current heads, stores it and saves.
func (s *Store) Append(id *ident.Identity, typ string, at int64, f Fields) (*Record, error) {
	limit := maxPrev
	if f.Via != "" {
		// An admit for an account names at most 8 heads, so its body stays within 2048 bytes.
		limit = maxAccountAdmitPrev
	}
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
	r, err := Sign(id, s.MeshID, typ, n, s.choosePrev(own, limit), at, f)
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	added, err := s.merge([]*Record{r})
	if len(added) == 1 {
		err = nil
	} else if err == nil {
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
