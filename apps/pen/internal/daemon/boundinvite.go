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

// boundInviteRequest is an invite op that names its subject (contract "Bound invites").
type boundInviteRequest struct {
	Op      string        `json:"op"`
	TTLMs   int64         `json:"ttlMs,omitempty"`
	Wait    bool          `json:"wait,omitempty"`
	Subject *mesh.Subject `json:"subject"`
	MintID  string        `json:"mintId,omitempty"`
}

// inviteRef names one bound invite by its id or by the mintId that made it, exactly one of them.
type inviteRef struct {
	Op       string `json:"op"`
	InviteID string `json:"inviteId,omitempty"`
	MintID   string `json:"mintId,omitempty"`
}

// InviteCancelReply answers invite.cancel.
type InviteCancelReply struct {
	T        string `json:"t"`
	InviteID string `json:"inviteId,omitempty"`
	MintID   string `json:"mintId,omitempty"`
	State    string `json:"state"`
}

// boundOp reports whether a control line is a bound-invite op, which handleControl serves before decoding a
// Request: Request.Subject is a string, so an older node answers an invite with a subject object "bad request" and
// makes nothing, and it answers the other ops "unknown op".
func boundOp(line []byte) bool {
	var head struct {
		Op      string          `json:"op"`
		Subject json.RawMessage `json:"subject"`
		MintID  json.RawMessage `json:"mintId"`
	}
	if json.Unmarshal(line, &head) != nil {
		return false
	}
	switch head.Op {
	case "invite.cancel":
		return true
	case "invite":
		return len(head.MintID) > 0 || len(head.Subject) > 0 && head.Subject[0] == '{'
	}
	return false
}

var errBadRequest = errors.New("bad request")

func (d *Daemon) controlBound(ctx context.Context, c net.Conn, line []byte, reply func(any), fail func(error)) {
	var head struct {
		Op string `json:"op"`
	}
	json.Unmarshal(line, &head)
	if head.Op != "invite" {
		var ref inviteRef
		if strictjson.Unmarshal(line, &ref) != nil || !validRef(ref) {
			fail(errBadRequest)
			return
		}
		state, err := d.inviteBook().Cancel(ref.InviteID, ref.MintID, d.now())
		if err != nil {
			fail(err)
			return
		}
		reply(InviteCancelReply{T: "invite-cancel", InviteID: ref.InviteID, MintID: ref.MintID, State: state})
		return
	}
	var req boundInviteRequest
	if err := strictjson.Unmarshal(line, &req); err != nil || req.Subject == nil {
		fail(errBadRequest)
		return
	}
	ttl := time.Duration(req.TTLMs) * time.Millisecond
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	now := d.now()
	inv, err := d.inviteBook().CreateBound(*req.Subject, req.MintID, now.Add(ttl), now)
	if err != nil {
		fail(err)
		return
	}
	r := d.inviteReply(inv)
	r.ID, r.MintID = inv.ID, inv.MintID
	if !req.Wait {
		reply(r)
		return
	}
	d.awaitJoin(ctx, c, r, inv.ID, reply)
}

// validRef checks that exactly one of the invite id (12 bytes in canonical base64url) and a valid mintId is set.
func validRef(ref inviteRef) bool {
	if (ref.InviteID == "") == (ref.MintID == "") {
		return false
	}
	if ref.MintID != "" {
		return mesh.ValidMintID(ref.MintID)
	}
	b, err := ident.B64.DecodeString(ref.InviteID)
	return err == nil && len(b) == 12 && ident.B64.EncodeToString(b) == ref.InviteID
}
