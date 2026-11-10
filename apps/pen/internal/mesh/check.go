package mesh

import (
	"context"
	"encoding/json"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// serveCheck answers a kind 0x04 check (contract "Account join"): a joiner that this member refused
// on kind 0x01 asks whether the records it holds make it a member here. The member merges them into
// a scratch copy of its own set and sends its records only if they make the joiner a member through
// admits none of which this member's own view counts as revoked, else it refuses 4401. It stores
// nothing the joiner sent; the joiner's admit reaches it by the usual syncs.
func serveCheck(ctx context.Context, c *Lines, remoteStatic []byte, a AccountAdmission, assertion json.RawMessage) error {
	claim, err := a.Check(assertion, a.Store.View())
	if err != nil {
		return refuse(c, err.Error())
	}
	if claim.NoisePub != ident.B64.EncodeToString(remoteStatic) {
		return refuse(c, "the assertion is not for this session's key")
	}
	if err := c.Write(Msg{T: "hello", Pen: Version, Have: a.Store.hashes()}); err != nil {
		return err
	}
	scratch := NewStore(nil, a.Store.MeshID)
	scratch.uncapped = true
	_, err = scratch.Merge(a.Store.Records())
	scratch.uncapped = false
	if err != nil {
		return err
	}
	var have []string
	gotHello := false
	received := 0
	for {
		m, err := c.Read(ctx)
		if err != nil {
			return err
		}
		switch m.T {
		case "hello":
			if gotHello {
				c.L.Close(errLine.Code)
				return errLine
			}
			gotHello, have = true, m.Have
		case "records":
			if err := scratch.take(c.L, m, nil, &received); err != nil {
				return err
			}
		case "done":
			if !gotHello {
				c.L.Close(errLine.Code)
				return errLine
			}
			if !admittedCleanly(scratch.View(), a.Store.View(), claim.SignPub) {
				return refuse(c, "with the records it holds this machine is still not a member here")
			}
			if err := c.writeRecords(a.Store.missingFrom(have)); err != nil {
				return err
			}
			if err := c.Write(Msg{T: "done"}); err != nil {
				return err
			}
			c.L.Close(wire.CodeNormal)
			return nil
		}
	}
}

// admittedCleanly reports whether k is a member of v whose admit, and each admit before it back to
// the founder, was signed by a key own does not count as revoked. Which of two keys revoking each
// other wins depends on the canonical order (a stolen key can grind it), so v alone cannot settle
// a set a revoked member served; own can.
func admittedCleanly(v, own *View, k string) bool {
	m, ok := v.Members[k]
	if !ok {
		return false
	}
	for steps := 0; m.AdmittedBy != ""; steps++ {
		if _, gone := own.Revoked[m.AdmittedBy]; gone || steps > len(v.Members)+len(v.Revoked) {
			return false
		}
		next, ok := v.Members[m.AdmittedBy]
		if !ok {
			next, ok = v.Revoked[m.AdmittedBy]
		}
		if !ok {
			return false
		}
		m = next
	}
	return true
}

// CheckWith runs the joiner side of a check over a confirmed kind 0x04 session: it sends the
// assertion and syncs as on kind 0x01. When the member takes it, s also holds the member's records;
// a refusal closes 4401, as a member older than this check does too.
func CheckWith(ctx context.Context, l Link, s *Store, assertion json.RawMessage) error {
	c := &Lines{L: l}
	if err := c.Write(Msg{T: "check", Assertion: assertion}); err != nil {
		return err
	}
	return SyncInitiate(ctx, l, s, nil, nil)
}
