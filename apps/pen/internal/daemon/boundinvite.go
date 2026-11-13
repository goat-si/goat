package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/strictjson"
)

// boundInviteRequest is an invite op that names its subject (contract "Bound invites").
type boundInviteRequest struct {
	Op      string        `json:"op"`
	TTLMs   int64         `json:"ttlMs,omitempty"`
	Wait    bool          `json:"wait,omitempty"`
	Subject *mesh.Subject `json:"subject"`
}

// boundOp reports whether a control line is a bound-invite op, which handleControl serves before decoding a
// Request: Request.Subject is a string, so an older node answers such a line "bad request" and makes nothing.
func boundOp(line []byte) bool {
	var head struct {
		Op      string          `json:"op"`
		Subject json.RawMessage `json:"subject"`
	}
	if json.Unmarshal(line, &head) != nil {
		return false
	}
	return head.Op == "invite" && len(head.Subject) > 0 && head.Subject[0] == '{'
}

func (d *Daemon) controlBound(ctx context.Context, c net.Conn, line []byte, reply func(any), fail func(error)) {
	var req boundInviteRequest
	if err := strictjson.Unmarshal(line, &req); err != nil || req.Subject == nil {
		fail(errors.New("bad request"))
		return
	}
	ttl := time.Duration(req.TTLMs) * time.Millisecond
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	now := d.now()
	inv, err := d.inviteBook().CreateBound(*req.Subject, now.Add(ttl), now)
	if err != nil {
		fail(err)
		return
	}
	r := d.inviteReply(inv)
	r.ID = inv.ID
	if !req.Wait {
		reply(r)
		return
	}
	d.awaitJoin(ctx, c, r, inv.ID, reply)
}
