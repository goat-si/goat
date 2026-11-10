package mesh

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// AccountWait bounds the wait for an account joiner's assertion and for its card (contract
// "Account join").
const AccountWait = 10 * time.Second

// Claim is what a member's check of an assertion yields.
type Claim struct {
	SignPub  string
	NoisePub string
	Email    string
	// Sub is the assertion's Google account.
	Sub string
	// Hash is base64url SHA-256 of the assertion body.
	Hash string
}

// AccountAdmission is what a member needs to serve one account join.
type AccountAdmission struct {
	ID    *ident.Identity
	Store *Store
	Now   func() time.Time
	// Wait bounds the assertion and card waits (AccountWait when zero).
	Wait time.Duration
	// Asserted runs once the assertion arrived.
	Asserted func()
	// Check decides on the assertion against view v; an error is the refusal reason.
	Check func(raw json.RawMessage, v *View) (Claim, error)
	// Queue keeps a request while the mesh is locked and returns its id.
	Queue func(card *Card, c Claim) (string, error)
	// OnAdmit is called with the admit record after it is stored.
	OnAdmit func(admit *Record)
	// Refresh, when set, syncs with the other reachable members before the decision, so a lock,
	// unbind or revoke this member has not heard of yet still counts.
	Refresh func()
}

// AccountResult is how a member served an account join.
type AccountResult struct {
	Admitted *Member
	QueuedID string
}

// readWithin reads one line within d; a peer that sends nothing in time is closed 4408.
func readWithin(ctx context.Context, c *Lines, d time.Duration) (*Msg, error) {
	rctx, cancel := context.WithTimeout(ctx, d)
	defer cancel()
	m, err := c.Read(rctx)
	if err != nil && rctx.Err() != nil && ctx.Err() == nil {
		c.L.Close(wire.CodeTimeout)
		return nil, &relay.CloseError{Code: wire.CodeTimeout}
	}
	return m, err
}

// ServeAccount runs the member side of a confirmed kind 0x04 session from remoteStatic.
func ServeAccount(ctx context.Context, l Link, remoteStatic []byte, a AccountAdmission) (AccountResult, error) {
	c := &Lines{L: l}
	wait := a.Wait
	if wait <= 0 {
		wait = AccountWait
	}
	m, err := readWithin(ctx, c, wait)
	if err != nil {
		return AccountResult{}, err
	}
	if m.T != "assertion" || len(m.Assertion) == 0 {
		return AccountResult{}, refuse(c, "expected an assertion")
	}
	if a.Asserted != nil {
		a.Asserted()
	}
	assertion := m.Assertion
	claim, err := a.Check(assertion, a.Store.View())
	if err != nil {
		return AccountResult{}, refuse(c, err.Error())
	}
	if claim.NoisePub != ident.B64.EncodeToString(remoteStatic) {
		return AccountResult{}, refuse(c, "the assertion is not for this session's key")
	}
	nonce, err := randomNonce()
	if err != nil {
		return AccountResult{}, err
	}
	self := a.ID.NodeID()
	if err := c.Write(Msg{T: "offer", Mesh: a.Store.MeshID, Inviter: self, Nonce: nonce}); err != nil {
		return AccountResult{}, err
	}
	if m, err = readWithin(ctx, c, wait); err != nil {
		return AccountResult{}, err
	}
	if m.T != "card" || m.Card == nil {
		return AccountResult{}, refuse(c, "expected a card")
	}
	if err := m.Card.Verify(); err != nil {
		return AccountResult{}, refuse(c, err.Error())
	}
	cb := m.Card.C
	if cb.Mesh != a.Store.MeshID || cb.Inviter != self || cb.Nonce != nonce {
		return AccountResult{}, refuse(c, "card does not answer this offer")
	}
	if cb.SignPub != claim.SignPub || cb.NoisePub != claim.NoisePub {
		return AccountResult{}, refuse(c, "the card's keys are not the assertion's")
	}
	// The binding may have changed while the card was on its way, or elsewhere while this member
	// was away: sync, then decide on one view taken now.
	if a.Refresh != nil {
		a.Refresh()
	}
	v := a.Store.View()
	if claim, err = a.Check(assertion, v); err != nil {
		return AccountResult{}, refuse(c, err.Error())
	}
	if _, gone := v.Revoked[cb.SignPub]; gone {
		return AccountResult{}, refuse(c, "this key was revoked")
	}
	for _, x := range v.Members {
		if x.SignPub == cb.SignPub || x.NoisePub == cb.NoisePub || x.NodeID == cb.NodeID {
			return AccountResult{}, refuse(c, "already a member")
		}
	}
	if v.Locked {
		id, err := a.Queue(m.Card, claim)
		if err != nil {
			return AccountResult{}, refuse(c, err.Error())
		}
		name := v.Members[ident.B64.EncodeToString(a.ID.SignPub)].Name
		if err := c.Write(Msg{T: "queued", ID: id, Member: name}); err != nil {
			return AccountResult{}, err
		}
		l.Close(wire.CodeNormal)
		return AccountResult{QueuedID: id}, nil
	}
	member, err := AdmitAccount(a.ID, a.Store, m.Card, claim, a.Now())
	if err != nil {
		return AccountResult{}, refuse(c, err.Error())
	}
	if a.OnAdmit != nil {
		a.OnAdmit(member.admit)
	}
	if err := c.writeRecords(a.Store.Records()); err != nil {
		return AccountResult{}, err
	}
	if err := c.Write(Msg{T: "done", Mesh: a.Store.MeshID}); err != nil {
		return AccountResult{}, err
	}
	return AccountResult{Admitted: &member.Member}, nil
}

type admitted struct {
	Member
	admit *Record
}

// AdmitAccount signs an admit via google for card and checks it made the subject a member.
func AdmitAccount(id *ident.Identity, s *Store, card *Card, c Claim, now time.Time) (admitted, error) {
	admit, err := s.Append(id, TypeAdmit, now.UnixMilli(), Fields{Card: card, Via: ViaGoogle, Email: c.Email, Assertion: c.Hash})
	if err != nil {
		return admitted{}, fmt.Errorf("could not sign the admit: %w", err)
	}
	m, ok := s.View().Members[card.C.SignPub]
	if !ok {
		return admitted{}, errors.New("admit had no effect")
	}
	return admitted{Member: m, admit: admit}, nil
}

// AccountOutcome is the joiner's result: the joined set, or a queued request.
type AccountOutcome struct {
	MeshID  string
	Records []*Record
	// QueuedID and QueuedBy are set when a locked mesh queued the request on member QueuedBy.
	QueuedID string
	QueuedBy string
}

// AccountJoin runs the joiner side of a confirmed kind 0x04 session with assertion (its JSON form).
func AccountJoin(ctx context.Context, l Link, id *ident.Identity, name string, assertion json.RawMessage) (AccountOutcome, error) {
	c := &Lines{L: l}
	if err := c.Write(Msg{T: "assertion", Assertion: assertion}); err != nil {
		return AccountOutcome{}, err
	}
	m, err := c.Read(ctx)
	if err != nil {
		return AccountOutcome{}, err
	}
	if m.T == "refused" {
		return AccountOutcome{}, &RefusedError{Reason: m.Reason}
	}
	if m.T != "offer" || m.Mesh == "" || !ident.ValidNodeID(m.Inviter) {
		l.Close(wire.CodeCrypto)
		return AccountOutcome{}, errors.New("account join: expected an offer")
	}
	card, err := MakeCard(id, m.Mesh, m.Inviter, m.Nonce, name)
	if err != nil {
		return AccountOutcome{}, err
	}
	if err := c.Write(Msg{T: "card", Card: card}); err != nil {
		return AccountOutcome{}, err
	}
	out := AccountOutcome{MeshID: m.Mesh}
	for {
		m, err := c.Read(ctx)
		if err != nil {
			return AccountOutcome{}, err
		}
		switch m.T {
		case "refused":
			return AccountOutcome{}, &RefusedError{Reason: m.Reason}
		case "queued":
			out.QueuedID, out.QueuedBy = m.ID, m.Member
			return out, nil
		case "records":
			out.Records = append(out.Records, m.Records...)
			if len(out.Records) > MaxRecords {
				l.Close(wire.CodeCrypto)
				return AccountOutcome{}, errors.New("account join: more than 4096 records")
			}
		case "done":
			if m.Mesh != out.MeshID {
				l.Close(wire.CodeCrypto)
				return AccountOutcome{}, errors.New("account join: done names another mesh")
			}
			return out, nil
		}
	}
}

// SameKey reports whether a base64url key names b.
func SameKey(k string, b []byte) bool {
	d, err := ident.DecodeKey(k)
	return err == nil && bytes.Equal(d, b)
}
