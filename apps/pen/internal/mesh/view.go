package mesh

import (
	"container/heap"
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
	Since      int64    `json:"since"`
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
func (h hashHeap) Less(i, j int) bool { return h[i].Hash < h[j].Hash }
func (h hashHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *hashHeap) Push(x any)        { *h = append(*h, x.(*Record)) }
func (h *hashHeap) Pop() any {
	old := *h
	r := old[len(old)-1]
	*h = old[:len(old)-1]
	return r
}

// CanonicalOrder is Kahn's topological order over prev edges, smallest hash string first among
// ready records. Records whose prev is not all in the set are left out.
func CanonicalOrder(recs []*Record) []*Record {
	byHash := make(map[string]*Record, len(recs))
	for _, r := range recs {
		byHash[r.Hash] = r
	}
	indeg := make(map[string]int, len(recs))
	children := make(map[string][]*Record, len(recs))
	ready := &hashHeap{}
	for _, r := range byHash {
		missing := false
		for _, p := range r.B.Prev {
			if byHash[p] == nil {
				missing = true
			}
			children[p] = append(children[p], r)
		}
		switch {
		case missing:
			indeg[r.Hash] = -1 // never ready, nor are its descendants
		case len(r.B.Prev) == 0:
			heap.Push(ready, r)
		default:
			indeg[r.Hash] = len(r.B.Prev)
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
func Compute(meshID string, recs []*Record) *View {
	order := CanonicalOrder(recs)
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
			j := pos[p]
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
				if anc[i][j/64]&(1<<(j%64)) != 0 {
					inPast = true
					break
				}
			}
			if !inPast {
				continue
			}
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
			v.Members[c.SignPub] = Member{NodeID: c.NodeID, SignPub: c.SignPub, NoisePub: c.NoisePub, Name: c.Name, AdmittedBy: b.By, Since: b.At}
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
			v.Members[b.By] = m
		}
		v.Effective[r.Hash] = true
	}
	return v
}
