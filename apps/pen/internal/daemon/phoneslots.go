package daemon

// Phone slots (contract "Phone slots"): every kind 0x01 handshake from a key admitted by a list, and every
// service-pair handshake, holds one slot from before message 2 until its session ends, so phones and pairings take at
// most 8 of a relay's 32 active sessions.
const (
	phoneSlotsPerRelay = 8
	phoneSlotsPerNode  = 12
	phoneSlotsPerKey   = 4
)

// phoneSlot is one held slot; released makes release idempotent. Both are guarded by serviceBook.mu.
type phoneSlot struct {
	relay, key string
	released   bool
}

// phoneCounts are the slots held, by configured relay, by initiator key and in total.
type phoneCounts struct {
	byRelay map[string]int
	byKey   map[string]int
	total   int
}

// reservePhoneLocked takes a slot for key on relay if all three caps have room; serviceBook.mu is held.
func (b *serviceBook) reservePhoneLocked(relay, key string) (*phoneSlot, bool) {
	c := &b.phones
	if c.byRelay == nil {
		c.byRelay, c.byKey = map[string]int{}, map[string]int{}
	}
	if c.byRelay[relay] >= phoneSlotsPerRelay || c.total >= phoneSlotsPerNode || c.byKey[key] >= phoneSlotsPerKey {
		return nil, false
	}
	c.byRelay[relay]++
	c.byKey[key]++
	c.total++
	b.notePhonesLocked()
	return &phoneSlot{relay: relay, key: key}, true
}

// releasePhone returns s once, whatever ended its session.
func (b *serviceBook) releasePhone(s *phoneSlot) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if s.released {
		return
	}
	s.released = true
	c := &b.phones
	for _, m := range []struct {
		counts map[string]int
		k      string
	}{{c.byRelay, s.relay}, {c.byKey, s.key}} {
		if m.counts[m.k]--; m.counts[m.k] == 0 {
			delete(m.counts, m.k)
		}
	}
	c.total--
	b.notePhonesLocked()
}

// notePhonesLocked tells a test hook the node-wide count, in the order the changes happen.
func (b *serviceBook) notePhonesLocked() {
	if b.onPhones != nil {
		b.onPhones(b.phones.total)
	}
}
