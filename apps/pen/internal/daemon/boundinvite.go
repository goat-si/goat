package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/strictjson"
)

// Features is the status op's feature list: a subject on invite, invite.cancel, a mintId with an absolute expiresAt,
// and invite.status with kept terminal entries and invite.ack.
var Features = []string{"invite.subject/1", "invite.cancel/1", "invite.mint/1", "invite.status/1"}

// boundInviteRequest is an invite op that names its subject (contract "Bound invites").
type boundInviteRequest struct {
	Op      string        `json:"op"`
	TTLMs   int64         `json:"ttlMs,omitempty"`
	Wait    bool          `json:"wait,omitempty"`
	Subject *mesh.Subject `json:"subject"`
	MintID  string        `json:"mintId,omitempty"`
	// ExpiresAt is an absolute expiry in Unix milliseconds; it comes with MintID and replaces TTLMs.
	ExpiresAt int64 `json:"expiresAt,omitempty"`
}

// inviteRef names one bound invite by its id or by the mintId that made it, exactly one of them.
type inviteRef struct {
	Op       string `json:"op"`
	InviteID string `json:"inviteId,omitempty"`
	MintID   string `json:"mintId,omitempty"`
}

// InviteCancelReply answers invite.cancel, and invite.ack with T "invite-ack".
type InviteCancelReply struct {
	T        string `json:"t"`
	InviteID string `json:"inviteId,omitempty"`
	MintID   string `json:"mintId,omitempty"`
	State    string `json:"state"`
}

// boundOp reports whether a control line is a bound-invite op, which handleControl serves before decoding a
// Request: an invite carrying a subject, mintId or expiresAt member, or one of the other ops. Request.Subject is a
// string, so an older node answers an invite with a subject object "bad request" and makes nothing, and it answers
// the other ops "unknown op".
func boundOp(line []byte) bool {
	var head struct {
		Op        string          `json:"op"`
		Subject   json.RawMessage `json:"subject"`
		MintID    json.RawMessage `json:"mintId"`
		ExpiresAt json.RawMessage `json:"expiresAt"`
	}
	if json.Unmarshal(line, &head) != nil {
		return false
	}
	switch head.Op {
	case "invite.cancel", "invite.status", "invite.ack":
		return true
	case "invite":
		// Any subject member at all, null or a string included, asks for a bound invite and is refused there if malformed.
		return len(head.MintID) > 0 || len(head.ExpiresAt) > 0 || len(head.Subject) > 0
	}
	return false
}

var errBadRequest = errors.New("bad request")

func (d *Daemon) controlBound(ctx context.Context, c net.Conn, line []byte, reply func(any), fail func(error)) {
	var head struct {
		Op string `json:"op"`
	}
	json.Unmarshal(line, &head)
	has, err := presentMembers(line)
	if err != nil {
		fail(err)
		return
	}
	if head.Op != "invite" {
		var ref inviteRef
		if strictjson.Unmarshal(line, &ref) != nil || !validRef(ref, has) {
			fail(errBadRequest)
			return
		}
		switch head.Op {
		case "invite.status":
			store, book := d.meshAndBook()
			s, err := mesh.StatusOf(store, book, ref.InviteID, ref.MintID, d.now)
			if err != nil {
				fail(err)
				return
			}
			reply(s)
		case "invite.ack":
			state, err := d.inviteBook().Ack(ref.InviteID, ref.MintID, d.now)
			if err != nil {
				fail(err)
				return
			}
			reply(InviteCancelReply{T: "invite-ack", InviteID: ref.InviteID, MintID: ref.MintID, State: state})
		default:
			state, err := d.inviteBook().Cancel(ref.InviteID, ref.MintID, d.now)
			if err != nil {
				fail(err)
				return
			}
			reply(InviteCancelReply{T: "invite-cancel", InviteID: ref.InviteID, MintID: ref.MintID, State: state})
		}
		return
	}
	var req boundInviteRequest
	if err := strictjson.Unmarshal(line, &req); err != nil || req.Subject == nil {
		fail(errBadRequest)
		return
	}
	now := d.now()
	expiresAt, err := boundExpiry(req, has, now)
	if err != nil {
		fail(err)
		return
	}
	var sig *mesh.Signals
	if req.Wait {
		sig = mesh.NewSignals()
	}
	book := d.inviteBook()
	inv, err := book.CreateBoundNotify(*req.Subject, req.MintID, expiresAt, d.now, sig)
	if err != nil {
		fail(err)
		return
	}
	r := d.inviteReply(inv)
	r.ID, r.MintID = inv.ID, inv.MintID
	if d.boundCreated != nil {
		d.boundCreated(inv.ID)
	}
	if !req.Wait {
		reply(r)
		return
	}
	d.awaitJoin(ctx, c, r, book, inv.ID, sig, reply)
}

// maxBoundExpiry bounds how far ahead a caller's expiresAt may be.
const maxBoundExpiry = 24 * time.Hour

// boundExpiry is the invite's expiry: the caller's absolute expiresAt, which comes with a mintId and without ttlMs
// and is at most maxBoundExpiry ahead, or ttlMs (10 minutes when absent). A passed expiresAt is refused under the
// invite book's lock (CreateBound).
// has names the members the line carries, so the rules follow what was sent, not what decoded to zero.
func boundExpiry(req boundInviteRequest, has map[string]bool, now time.Time) (time.Time, error) {
	if has["mintId"] != has["expiresAt"] {
		return time.Time{}, errors.New("mintId and expiresAt go together")
	}
	if has["expiresAt"] {
		if has["ttlMs"] {
			return time.Time{}, errors.New("expiresAt replaces ttlMs; send one of them")
		}
		if req.ExpiresAt <= 0 || !mesh.ValidMintID(req.MintID) {
			return time.Time{}, errBadRequest
		}
		t := time.UnixMilli(req.ExpiresAt)
		if t.After(now.Add(maxBoundExpiry)) {
			return time.Time{}, errors.New("expiresAt is more than 24 hours ahead")
		}
		return t, nil
	}
	ttl := time.Duration(req.TTLMs) * time.Millisecond
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	return now.Add(ttl), nil
}

// presentMembers names the members of a bound-invite line and refuses one that is null, which would decode like an
// absent member.
func presentMembers(line []byte) (map[string]bool, error) {
	var members map[string]json.RawMessage
	if err := json.Unmarshal(line, &members); err != nil {
		return nil, errBadRequest
	}
	has := map[string]bool{}
	for k, v := range members {
		if string(v) == "null" {
			return nil, errBadRequest
		}
		has[k] = true
	}
	return has, nil
}

// validRef checks that the line carries exactly one of inviteId (12 bytes in canonical base64url) and mintId, and
// that the one it carries is valid; an empty one is not taken for absent.
func validRef(ref inviteRef, has map[string]bool) bool {
	if has["inviteId"] == has["mintId"] {
		return false
	}
	if has["mintId"] {
		return mesh.ValidMintID(ref.MintID)
	}
	b, err := ident.B64.DecodeString(ref.InviteID)
	return err == nil && len(b) == 12 && ident.B64.EncodeToString(b) == ref.InviteID
}
