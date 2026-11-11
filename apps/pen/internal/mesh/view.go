package mesh

import (
	"bytes"
	"container/heap"
	"slices"
	"sort"

	"github.com/goat-si/goat/apps/pen/internal/ident"
)

// Member is a node in the view.
type Member struct {
	NodeID     string   `json:"nodeId"`
	SignPub    string   `json:"signPub"`
	NoisePub   string   `json:"noisePub"`
	Name       string   `json:"name"`
	AdmittedBy string   `json:"admittedBy,omitempty"`
	HostKeys   []string `json:"hostKeys,omitempty"`
	// User is the SSH login name from the member's latest hostkeys record.
	User  string `json:"user,omitempty"`
	Since int64  `json:"since"`
	// Via is "google" for a member admitted for a Google account assertion; Email is that account's.
	Via   string `json:"via,omitempty"`
	Email string `json:"email,omitempty"`
}

// View is the state replayed from a record set.
type View struct {
	MeshID string
	// Members are current members by signPub (base64url).
	Members map[string]Member
	// Revoked are revoked keys; a key that was once a member keeps its last member entry.
	Revoked map[string]Member
	// Order is the canonical replay order (record hashes); Effective marks records that took effect.
	Order     []string
	Effective map[string]bool
	// Account is the mesh's binding (nil when unbound); Locked is lock mode.
	Account *Account
	Locked  bool
}

// MemberByNoise finds a current member by Noise static key.
func (v *View) MemberByNoise(noisePub []byte) (Member, bool) {
	k := ident.B64.EncodeToString(noisePub)
	for _, m := range v.Members {
		if m.NoisePub == k {
			return m, true
		}
	}
	return Member{}, false
}

// MemberByNodeID finds a current member by nodeId.
func (v *View) MemberByNodeID(nodeID string) (Member, bool) {
	for _, m := range v.Members {
		if m.NodeID == nodeID {
			return m, true
		}
	}
	return Member{}, false
}

// RevokedByNodeID finds a revoked key by nodeId.
func (v *View) RevokedByNodeID(nodeID string) (Member, bool) {
	for _, m := range v.Revoked {
		if m.NodeID == nodeID {
			return m, true
		}
	}
	return Member{}, false
}

// SortedMembers lists current members by name then nodeId.
func (v *View) SortedMembers() []Member { return sortMembers(v.Members) }

// SortedRevoked lists revoked keys by name then nodeId.
func (v *View) SortedRevoked() []Member { return sortMembers(v.Revoked) }

func sortMembers(m map[string]Member) []Member {
	out := make([]Member, 0, len(m))
	for _, x := range m {
		out = append(out, x)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].NodeID < out[j].NodeID
	})
	return out
}

type hashHeap []*Record

func (h hashHeap) Len() int           { return len(h) }
func (h hashHeap) Less(i, j int) bool { return bytes.Compare(h[i].Sum[:], h[j].Sum[:]) < 0 }
func (h hashHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *hashHeap) Push(x any)        { *h = append(*h, x.(*Record)) }
func (h *hashHeap) Pop() any {
	old := *h
	r := old[len(old)-1]
	*h = old[:len(old)-1]
	return r
}

// CanonicalOrder is Kahn's topological order over prev edges, smallest raw SHA-256 first among
// ready records. Records whose prev is not all in the set are left out.
func CanonicalOrder(recs []*Record) []*Record { return canonicalOrder(recs, nil) }

// canonicalOrder is CanonicalOrder where a prev in bare counts as present (ADR-0026 bare hashes).
func canonicalOrder(recs []*Record, bare map[string]bool) []*Record {
	byHash := make(map[string]*Record, len(recs))
	for _, r := range recs {
		byHash[r.Hash] = r
	}
	indeg := make(map[string]int, len(recs))
	children := make(map[string][]*Record, len(recs))
	ready := &hashHeap{}
	for _, r := range byHash {
		missing := false
		held := 0
		for _, p := range r.B.Prev {
			if byHash[p] == nil {
				missing = missing || !bare[p]
				continue
			}
			held++
			children[p] = append(children[p], r)
		}
		switch {
		case missing:
			indeg[r.Hash] = -1 // never ready, nor are its descendants
		case held == 0:
			heap.Push(ready, r)
		default:
			indeg[r.Hash] = held
		}
	}
	out := make([]*Record, 0, len(byHash))
	for ready.Len() > 0 {
		r := heap.Pop(ready).(*Record)
		out = append(out, r)
		for _, c := range children[r.Hash] {
			indeg[c.Hash]--
			if indeg[c.Hash] == 0 {
				heap.Push(ready, c)
			}
		}
	}
	return out
}

type chainKey struct {
	by string
	n  uint64
}

// Compute replays recs in canonical order (contract "View").
func Compute(meshID string, recs []*Record) *View { return compute(meshID, recs, nil, false) }

// compute is Compute where a prev in bare counts as present and holds nothing, and with direct a
// record's own previous one counts only when named in its prev (ADR-0026).
func compute(meshID string, recs []*Record, bare map[string]bool, direct bool) *View {
	order := canonicalOrder(recs, bare)
	v := &View{MeshID: meshID, Members: map[string]Member{}, Revoked: map[string]Member{}, Effective: map[string]bool{}}
	pos := make(map[string]int, len(order))
	for i, r := range order {
		pos[r.Hash] = i
		v.Order = append(v.Order, r.Hash)
	}
	// anc[i] is the set of strict ancestors of order[i], as a bitset over positions.
	words := (len(order) + 63) / 64
	anc := make([][]uint64, len(order))
	byChain := map[chainKey][]int{}
	for i, r := range order {
		a := make([]uint64, words)
		for _, p := range r.B.Prev {
			j, ok := pos[p]
			if !ok {
				continue // a bare hash: no record, no past
			}
			for w, x := range anc[j] {
				a[w] |= x
			}
			a[j/64] |= 1 << (j % 64)
		}
		anc[i] = a
		k := chainKey{r.B.By, r.B.N}
		byChain[k] = append(byChain[k], i)
	}
	claimed := map[chainKey]bool{}
	usedNonces := map[string]bool{}
	admitted := map[string][]string{}
	// compromised are keys revoked as compromised, directly or as admits of such a key; their
	// account and lock records lose effect.
	compromised := map[string]bool{}
	var accounts, locksOn, locksOff []int

	revoke := func(k string) {
		if m, ok := v.Members[k]; ok {
			v.Revoked[k] = m
			delete(v.Members, k)
		} else if _, ok := v.Revoked[k]; !ok {
			nodeID := ""
			if pub, err := ident.DecodeKey(k); err == nil {
				nodeID = ident.NodeID(pub)
			}
			v.Revoked[k] = Member{SignPub: k, NodeID: nodeID}
		}
	}

	for i, r := range order {
		b := &r.B
		k := chainKey{b.By, b.N}
		if claimed[k] {
			continue // fork: a second record with the same signer and n
		}
		claimed[k] = true
		if b.N > 1 {
			inPast := false
			for _, j := range byChain[chainKey{b.By, b.N - 1}] {
				if direct && !slices.Contains(b.Prev, order[j].Hash) {
					continue
				}
				if anc[i][j/64]&(1<<(j%64)) != 0 {
					inPast = true
					break
				}
			}
			if !inPast && direct && len(byChain[chainKey{b.By, b.N - 1}]) == 0 {
				// The signer's previous record was dropped from its share; naming its bare hash suffices.
				for _, p := range b.Prev {
					if bare[p] {
						inPast = true
						break
					}
				}
			}
			if !inPast {
				continue
			}
		}
		if r.Opaque {
			continue // stored and forwarded, without effect
		}
		if b.Type == TypeFound {
			if MeshIDOf(r) != meshID || len(v.Members) != 0 {
				continue
			}
			c := b.Card.C
			v.Members[c.SignPub] = Member{NodeID: c.NodeID, SignPub: c.SignPub, NoisePub: c.NoisePub, Name: c.Name, Since: b.At}
			usedNonces[c.Nonce] = true
			v.Effective[r.Hash] = true
			continue
		}
		if _, ok := v.Members[b.By]; !ok {
			continue
		}
		switch b.Type {
		case TypeAdmit:
			c := b.Card.C
			if _, gone := v.Revoked[c.SignPub]; gone || usedNonces[c.Nonce] {
				continue
			}
			if _, dup := v.Members[c.SignPub]; dup {
				continue
			}
			clash := false
			for _, m := range v.Members {
				if m.NoisePub == c.NoisePub || m.NodeID == c.NodeID {
					clash = true
					break
				}
			}
			if clash {
				continue
			}
			usedNonces[c.Nonce] = true
			m := Member{NodeID: c.NodeID, SignPub: c.SignPub, NoisePub: c.NoisePub, Name: c.Name, AdmittedBy: b.By, Since: b.At}
			if b.Via != nil {
				m.Via, m.Email = *b.Via, *b.Email
			}
			v.Members[c.SignPub] = m
			admitted[b.By] = append(admitted[b.By], c.SignPub)
		case TypeRevoke:
			for _, s := range b.Subjects {
				if b.Compromised != nil && *b.Compromised {
					queue := []string{s}
					seen := map[string]bool{s: true}
					for len(queue) > 0 {
						x := queue[0]
						queue = queue[1:]
						revoke(x)
						compromised[x] = true
						for _, y := range admitted[x] {
							if !seen[y] {
								seen[y] = true
								queue = append(queue, y)
							}
						}
					}
				} else {
					revoke(s)
				}
			}
		case TypeName:
			m, ok := v.Members[b.Subject]
			if !ok {
				continue
			}
			m.Name = b.Name
			v.Members[b.Subject] = m
		case TypeHostKeys:
			m := v.Members[b.By]
			m.HostKeys = append([]string(nil), b.Keys...)
			m.User = ""
			if b.User != nil {
				m.User = *b.User
			}
			v.Members[b.By] = m
		case TypeAccount:
			accounts = append(accounts, i)
		case TypeLock:
			if *b.On {
				locksOn = append(locksOn, i)
			} else {
				locksOff = append(locksOff, i)
			}
		}
		v.Effective[r.Hash] = true
	}
	kept := func(idx []int) []int {
		var out []int
		for _, i := range idx {
			if !compromised[order[i].B.By] {
				out = append(out, i)
			}
		}
		return out
	}
	// The binding is the last account record whose signer was not revoked as compromised.
	if acc := kept(accounts); len(acc) > 0 {
		v.Account, _ = accountOf(&order[acc[len(acc)-1]].B)
	}
	// Locked unless an unlock has every lock in its past. A compromised key's locks keep effect
	// (revoking a stolen machine must not reopen auto-admission); only its unlocks are dropped.
	on := locksOn
	if len(on) > 0 {
		v.Locked = true
		for _, off := range kept(locksOff) {
			all := true
			for _, j := range on {
				if anc[off][j/64]&(1<<(j%64)) == 0 {
					all = false
					break
				}
			}
			if all {
				v.Locked = false
				break
			}
		}
	}
	return v
}
