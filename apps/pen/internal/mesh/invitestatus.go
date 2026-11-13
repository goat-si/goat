package mesh

import (
	"encoding/json"
	"time"
)

// InviteStatus answers invite.status (contract "Bound invites").
type InviteStatus struct {
	T         string `json:"t"`
	InviteID  string `json:"inviteId,omitempty"`
	MintID    string `json:"mintId,omitempty"`
	State     string `json:"state"`
	ExpiresAt int64  `json:"expiresAt,omitempty"`
	Nonce     string `json:"nonce,omitempty"`
	Admit     string `json:"admit,omitempty"`
	Member    *bool  `json:"member,omitempty"`
}

// InviteBurnedUnsaved is a burned invite whose admit is in memory while the record set holds changes not yet on disk
// (a set without a state directory has no disk to lag behind).
const InviteBurnedUnsaved = "burned-unsaved"

// StatusOf reads the invite named by id or mintID together with the record set. It holds the store's lock and then
// the book's, the order of a burn, so a burn is never seen without the admit signed in the same hold.
// clock is read under both locks. An expired bound invite is settled before it is reported; when that save fails the
// answer is the error, never expired, since the invite would still be live after a clock set back.
func StatusOf(s *Store, iv *Invites, id, mintID string, clock func() time.Time) (InviteStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	iv.mu.Lock()
	x, ok := iv.findLocked(id, mintID)
	now := clock()
	if ok && x.Subject != nil && expired(x, now) {
		if err := iv.saveLocked(now); err != nil {
			iv.mu.Unlock()
			return InviteStatus{}, err
		}
		x, ok = iv.findLocked(id, mintID)
	}
	iv.mu.Unlock()
	out := InviteStatus{T: "invite-status", InviteID: id, MintID: mintID, State: InviteAbsent}
	if !ok {
		return out, nil
	}
	out.InviteID, out.MintID = x.ID, x.MintID
	switch {
	case x.State == "" && expired(x, now):
		out.State = InviteExpired
	case x.State == "":
		out.State, out.ExpiresAt = InviteLive, x.ExpiresAt
	case x.State != InviteBurned:
		out.State = x.State
	default:
		out.State, out.Nonce = InviteBurned, x.Nonce
		admit := s.admitOfLocked(x.Nonce, x.Subject)
		if admit == nil {
			break
		}
		if s.view == nil {
			s.view = compute(s.MeshID, s.all(), s.bare, s.shares)
		}
		_, member := s.view.Members[x.Subject.SignPub]
		out.Admit, out.Member = admit.Hash, &member
		if s.st != nil && s.changes != s.saved {
			out.State = InviteBurnedUnsaved
		}
	}
	return out, nil
}

// admitOfLocked finds the stored admit whose card repeats nonce and carries sub's keys; s.mu is held.
func (s *Store) admitOfLocked(nonce string, sub *Subject) *Record {
	if sub == nil || nonce == "" {
		return nil
	}
	for _, r := range s.recs {
		if r.B.Type != TypeAdmit || r.B.Card == nil {
			continue
		}
		var cb CardBody
		if json.Unmarshal(r.B.Card.Body, &cb) == nil && cb.Nonce == nonce && sub.admits(cb) {
			return r
		}
	}
	return nil
}
