package mesh

import (
	"errors"
	"os"
	"slices"
	"sort"
	"sync"
	"sync/atomic"

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

// ErrReplaced is returned by a save when the file now holds another mesh (this store was
// replaced, by this process or another), and ErrRemoved when the file was removed after this store
// read or wrote it (pen leave). Neither save writes.
var (
	ErrReplaced = errors.New("mesh: the state folder now holds another mesh; this set is not saved")
	ErrRemoved  = errors.New("mesh: the mesh file was removed; this set is not saved")
	errRetired  = errors.New("mesh: retired")
)

// Store is a node's record set for one mesh. It is safe for concurrent use.
type Store struct {
	st     *state.Store
	MeshID string

	mu    sync.Mutex
	recs  map[string]*Record
	selfN uint64
	// selfLast is the hash of this node's record selfN, which a share may have dropped.
	selfLast string
	view     *View
	// self is this node's signPub; its own records never wait in the pool.
	self string
	// uncapped is set while reloading the node's own saved set.
	uncapped bool
	// shares switches to ADR-0026 (shares.go); bare holds hashes kept records name without a record.
	shares bool
	bare   map[string]bool
	// version is the body version of this mesh's records, its found record's (0 until one is held).
	version int

	// pool holds records whose prev is incomplete, in memory only.
	pool    map[string]pooled
	poolSeq uint64
	poolBy  map[string]int
	// reach[k] holds stored records whose past (or self) has a found or admit introducing k.
	reach map[string]map[string]bool

	// saveMu holds one save from its snapshot to its rename. saveWaits and afterSnapshot, when
	// set, run when a save has to wait for another and after a save took its snapshot (tests).
	saveMu        sync.Mutex
	saveWaits     func()
	afterSnapshot func()

	// changes counts edits of the set and saved the count mesh.json last received, so a set
	// holding records it could not write knows it (Unsaved). onDisk names the files this store
	// read or wrote; adopt lets the next save replace a file holding another mesh (all under
	// mu). Retire holds mu; retired is atomic for reads under the state lock (mu comes first). burnGate
	// and retireSets, when set, run inside an invite admission before its burn and where Retire sets
	// retired (tests).
	changes, saved uint64
	onDisk         map[string]bool
	adopt          bool
	retired        atomic.Bool
	burnGate       func()
	retireSets     func()
}

type pooled struct {
	r   *Record
	seq uint64
}

type storeFile struct {
	MeshID   string    `json:"meshId"`
	Records  []*Record `json:"records"`
	Pool     []*Record `json:"pool"`
	SelfN    uint64    `json:"selfN"`
	SelfLast string    `json:"selfLast,omitempty"`
	Shares   bool      `json:"shares,omitempty"`
	// version is the store's mesh version at the snapshot, for checking the file's records.
	version int
}

// NewStore is an empty set for meshID; st may be nil for an unpersisted set.
func NewStore(st *state.Store, meshID string) *Store {
	return &Store{st: st, MeshID: meshID, recs: map[string]*Record{}, pool: map[string]pooled{},
		poolBy: map[string]int{}, reach: map[string]map[string]bool{}, onDisk: map[string]bool{},
		bare: map[string]bool{}}
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
	s.shares = f.Shares
	// The node's own saved set reloads whole: caps apply to records arriving from peers.
	s.uncapped = true
	_, err = s.merge(f.Records)
	s.uncapped = false
	if err != nil {
		return nil, err
	}
	s.selfN, s.selfLast = f.SelfN, f.SelfLast
	s.view = nil
	s.changes, s.saved = 0, 0
	s.onDisk[name] = true
	return s, nil
}

// Found creates a new mesh with id as its only member and persists it when st is set.
func Found(st *state.Store, id *ident.Identity, name string, at int64) (*Store, error) {
	return FoundV(1, st, id, name, at)
}

// FoundV is Found for a mesh of body version v: 1, or EpochShared (ADR-0026).
func FoundV(v int, st *state.Store, id *ident.Identity, name string, at int64) (*Store, error) {
	nonce, err := randomNonce()
	if err != nil {
		return nil, err
	}
	card, err := MakeCard(id, foundMesh, foundMesh, nonce, name)
	if err != nil {
		return nil, err
	}
	r, err := SignV(v, id, foundMesh, TypeFound, 1, nil, at, Fields{Card: card})
	if err != nil {
		return nil, err
	}
	s := NewStore(st, MeshIDOf(r))
	s.self = ident.B64.EncodeToString(id.SignPub)
	if _, err := s.Merge([]*Record{r}); err != nil {
		return nil, err
	}
	s.selfN, s.selfLast = 1, r.Hash
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

func (s *Store) belongs(r *Record) bool { return s.belongsTo(r, s.version) }

// belongsTo is belongs for a mesh of version (0 when not known yet); it reads no mutable field.
func (s *Store) belongsTo(r *Record, version int) bool {
	if version != 0 && r.B.V != version {
		return false
	}
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
		s.changes++
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
	if s.version == 0 {
		s.learnVersion(recs)
	}
	if s.shares {
		return s.mergeShared(recs), nil
	}
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

// Adopt lets this store's next save replace a file that holds another mesh: the node is moving to
// this mesh (join, adopt, sign-in founding over a solo mesh).
func (s *Store) Adopt() {
	s.mu.Lock()
	s.adopt = true
	s.mu.Unlock()
}

// Retire stops this store from writing again; the node has moved to another mesh. The flag is set under
// mu, so it never lands inside an admission's check, burn and signature.
func (s *Store) Retire() {
	s.mu.Lock()
	if s.retireSets != nil {
		s.retireSets()
	}
	s.retired.Store(true)
	s.mu.Unlock()
}

// Unsaved reports records this store holds that mesh.json has not received.
func (s *Store) Unsaved() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.changes != s.saved
}

// SaveFile writes the set to name in st under the state lock. The file decides what may replace
// it, so neither an older save of this store nor another store or process goes backwards: under
// the lock the save reads the file and writes the union of its records with the file's when the
// file holds the same mesh (records only grow); it does not write when the file holds another
// mesh (ErrReplaced, unless Adopt), was removed after this store had it (ErrRemoved), or the
// store is retired. One save of this store runs at a time from its snapshot to its rename.
func (s *Store) SaveFile(st *state.Store, name string) error {
	if !s.saveMu.TryLock() {
		if s.saveWaits != nil {
			s.saveWaits()
		}
		s.saveMu.Lock()
	}
	defer s.saveMu.Unlock()
	if s.retired.Load() {
		return nil
	}
	s.mu.Lock()
	gen, adopt, known := s.changes, s.adopt, s.onDisk[name]
	// The pool is not persisted (contract "Records").
	recs := s.all()
	f := storeFile{MeshID: s.MeshID, SelfN: s.selfN, SelfLast: s.selfLast, Pool: []*Record{}, Shares: s.shares, version: s.version}
	s.mu.Unlock()
	if s.afterSnapshot != nil {
		s.afterSnapshot()
	}
	unlock, err := st.Lock()
	if err != nil {
		return err
	}
	err = s.writeLocked(st, name, f, recs, adopt, known)
	unlock()
	if errors.Is(err, errRetired) {
		return nil
	}
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.onDisk[name] = true
	s.adopt = false
	if name == "mesh.json" && gen > s.saved {
		s.saved = gen
	}
	s.mu.Unlock()
	return nil
}

// writeLocked writes f under the state lock unless the file says this save is stale; it does not
// take s.mu.
func (s *Store) writeLocked(st *state.Store, name string, f storeFile, recs []*Record, adopt, known bool) error {
	if s.retired.Load() {
		return errRetired
	}
	var disk storeFile
	ok, err := st.ReadJSON(name, &disk)
	switch {
	case err != nil && !adopt:
		return err
	case err != nil:
	case !ok && known && !adopt:
		return ErrRemoved
	case ok && disk.MeshID != s.MeshID && !adopt:
		return ErrReplaced
	case ok && disk.MeshID == s.MeshID:
		have := make(map[string]bool, len(recs))
		for _, r := range recs {
			have[r.Hash] = true
		}
		for _, r := range disk.Records {
			if r != nil && !have[HashOf(r.Body)] && r.Verify() == nil && s.belongsTo(r, f.version) {
				recs = append(recs, r)
			}
		}
		if disk.SelfN > f.SelfN {
			f.SelfN, f.SelfLast = disk.SelfN, disk.SelfLast
		}
	}
	if f.Shares {
		// Another process may have written records this store has not seen: keep the shares of both.
		kept, _ := selectShares(s.MeshID, recs)
		recs = recs[:0]
		for _, r := range kept {
			recs = append(recs, r)
		}
		f.Records = canonicalOrder(recs, bareOf(kept))
	} else {
		f.Records = CanonicalOrder(recs)
	}
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
	return canonicalOrder(s.all(), s.bare)
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
		s.view = compute(s.MeshID, s.all(), s.bare, s.shares)
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

// ErrNotMember is AppendAsMember's and DoAsMember's refusal: the signer is not a member in the
// current view, so what it signs would have no effect.
var ErrNotMember = errors.New("mesh: this machine is not a member of the mesh")

// Append signs the signer's next record over the current heads, stores it and saves.
func (s *Store) Append(id *ident.Identity, typ string, at int64, f Fields) (*Record, error) {
	s.mu.Lock()
	return s.appendLocked(id, typ, at, f)
}

// AppendAsMember is Append for an admit: under the store's lock, so no merge comes between, it
// checks that id is a member of the current view, runs before (an invite's burn; nothing is
// signed when it fails) and appends. Lock order: the store, then what before takes (the invite
// book, then the state directory's lock); nothing takes them the other way round.
func (s *Store) AppendAsMember(id *ident.Identity, typ string, at int64, f Fields, before func(v *View) error) (*Record, error) {
	s.mu.Lock()
	if !s.memberLocked(id) {
		s.mu.Unlock()
		return nil, ErrNotMember
	}
	if before != nil {
		if err := before(s.view); err != nil {
			s.mu.Unlock()
			return nil, err
		}
	}
	return s.appendLocked(id, typ, at, f)
}

// DoAsMember runs fn with the current view under the store's lock if id is a member of it
// (queueing a request for approval); fn must not use the store.
func (s *Store) DoAsMember(id *ident.Identity, fn func(v *View) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.memberLocked(id) {
		return ErrNotMember
	}
	return fn(s.view)
}

func (s *Store) memberLocked(id *ident.Identity) bool {
	// A retired store is a mesh this node has left: it admits and queues for nobody.
	if s.retired.Load() {
		return false
	}
	if s.view == nil {
		s.view = compute(s.MeshID, s.all(), s.bare, s.shares)
	}
	_, ok := s.view.Members[ident.B64.EncodeToString(id.SignPub)]
	return ok
}

// appendLocked signs and stores the record; s.mu is held and is released here.
func (s *Store) appendLocked(id *ident.Identity, typ string, at int64, f Fields) (*Record, error) {
	if s.retired.Load() {
		s.mu.Unlock()
		return nil, ErrNotMember
	}
	limit := maxPrev
	if f.Via != "" {
		// An admit for an account names at most 8 heads, so its body stays within 2048 bytes.
		limit = maxAccountAdmitPrev
	}
	if s.shares {
		// Dropped records leave many heads; naming 64 would pass the 2048-byte body limit.
		limit = min(limit, maxSharedPrev)
	}
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
	prev := s.choosePrev(own, limit)
	if s.shares && by == s.self && s.selfN > ownN && s.selfLast != "" {
		// A share dropped this node's latest record; it is still the one this record follows.
		own = s.selfLast
	}
	if s.shares && own != "" && !slices.Contains(prev, own) {
		// Under shares a record names its own previous one directly (ADR-0026 "Own chain").
		prev = append([]string{own}, prev[:min(len(prev), limit-1)]...)
	}
	if s.shares {
		// Every record names the found or admit that made its signer a member, so replay puts it after
		// the admission even when records between them, its own included, were dropped (ADR-0026).
		if s.view == nil {
			s.view = compute(s.MeshID, s.all(), s.bare, s.shares)
		}
		if h := s.view.admission[by]; h != "" && !slices.Contains(prev, h) {
			prev = append(prev, h)
			sort.Strings(prev)
		}
	}
	r, err := SignV(max(s.version, 1), id, s.MeshID, typ, n, prev, at, f)
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
	if by == s.self {
		s.selfLast = r.Hash
	}
	s.view = nil
	s.changes++
	s.mu.Unlock()
	return r, s.Save()
}
