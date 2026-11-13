package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"regexp"
	"strconv"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/strictjson"
)

// Limits of the ops on a registration (contract "Ops on the registration").
const (
	opLineCap       = 4096
	maxClients      = 8
	inviteBudget    = 4
	maxInviteAhead  = 10 * time.Minute
	maxSafeInteger  = 1<<53 - 1
	clientsOpName   = "service.clients"
	inviteOpName    = "service.invite"
	cancelOpName    = "service.invite.cancel"
	clientsService  = "goat"
	refusedNotGoat  = "only the goat registration holds clients and invites"
	refusedReplaced = "the registration ended"
)

// Bounds of the discard when a registration ends: after its last line the daemon half-closes and reads what the
// holder still sends, for at most holderDrainTime and holderDrainCap bytes, before it closes the connection
// (holderDrainTime is a variable for tests).
var holderDrainTime = 5 * time.Second

const holderDrainCap = 64 << 10

// serviceInvite is one service invite; its identity is the pointer, so a replacement never revives it.
type serviceInvite struct {
	id      string
	psk     []byte
	expires time.Time
	budget  int
	burned  bool
}

var jsonInteger = regexp.MustCompile(`^(0|[1-9][0-9]{0,15})$`)

// positiveInteger reads a JSON integer from 1 to 2^53-1 written with no sign, fraction or exponent.
func positiveInteger(raw json.RawMessage) (int64, bool) {
	if raw == nil || !jsonInteger.Match(raw) {
		return 0, false
	}
	n, err := strconv.ParseInt(string(raw), 10, 64)
	if err != nil || n < 1 || n > maxSafeInteger {
		return 0, false
	}
	return n, true
}

type opClients struct {
	Op      string            `json:"op"`
	Gen     json.RawMessage   `json:"gen"`
	Clients []json.RawMessage `json:"clients"`
}

type opClient struct {
	ID       string `json:"id"`
	NoisePub string `json:"noisePub"`
}

type opInvite struct {
	Op        string          `json:"op"`
	ID        string          `json:"id"`
	PSK       string          `json:"psk"`
	ExpiresAt json.RawMessage `json:"expiresAt"`
}

type opCancel struct {
	Op string `json:"op"`
	ID string `json:"id"`
}

// exact decodes b into v with exactly v's members, each present.
func exact(b []byte, v any) error {
	if err := strictjson.Unmarshal(b, v); err != nil {
		return err
	}
	keys, err := strictjson.Keys(b)
	if err != nil {
		return err
	}
	if len(keys) != len(strictjson.Names(v)) {
		return errors.New("a member is missing")
	}
	return nil
}

func opRefusal(op string, extra map[string]any, reason string) []byte {
	m := map[string]any{"t": "refused", "op": op, "reason": reason}
	for k, v := range extra {
		m[k] = v
	}
	return jsonLine(m)
}

func jsonLine(v any) []byte {
	b, _ := json.Marshal(v)
	return append(b, '\n')
}

// readOpLine reads one op line of at most opLineCap bytes with its LF from r.
func readOpLine(r *bufio.Reader) ([]byte, error) {
	b, err := r.ReadSlice('\n')
	if errors.Is(err, bufio.ErrBufferFull) || (err == nil && len(b) > opLineCap) {
		return nil, errors.New("an op line is over 4096 bytes")
	}
	if err != nil {
		return nil, err
	}
	return append([]byte(nil), b...), nil
}

// serveOps reads the holder's ops one at a time until the connection ends, the daemon stops, or the queue fails. Each
// answer is written before the next line is read.
func (d *Daemon) serveOps(ctx context.Context, reg *serviceReg, r *bufio.Reader) {
	type read struct {
		line []byte
		err  error
	}
	lines := make(chan read)
	next := make(chan struct{})
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		for {
			b, err := readOpLine(r)
			select {
			case lines <- read{b, err}:
			case <-stop:
				return
			}
			if err != nil {
				return
			}
			select {
			case <-next:
			case <-stop:
				return
			}
		}
	}()
	for {
		select {
		case in := <-lines:
			if in.err != nil {
				return
			}
			e, ok := d.handleOp(reg, in.line)
			if !ok || !reg.out.wait(e) {
				return
			}
			next <- struct{}{}
		case <-reg.out.dead:
			return
		case <-ctx.Done():
			return
		case <-d.stopCh:
			return
		}
	}
}

// handleOp acts on one op line and returns the queue entry of its answer.
func (d *Daemon) handleOp(reg *serviceReg, b []byte) (*holderEntry, bool) {
	keys, err := strictjson.Keys(b)
	var top map[string]json.RawMessage
	if err == nil {
		err = json.Unmarshal(b, &top)
	}
	if err != nil {
		_ = keys
		return reg.out.push(opRefusal("", nil, "not one JSON object with distinct members"))
	}
	var op string
	if json.Unmarshal(top["op"], &op) != nil || (op != clientsOpName && op != inviteOpName && op != cancelOpName) {
		return reg.out.push(opRefusal("", nil, "unknown op"))
	}
	extra := map[string]any{}
	switch op {
	case clientsOpName:
		if g, ok := positiveInteger(top["gen"]); ok {
			extra["gen"] = g
		}
	default:
		var id string
		if json.Unmarshal(top["id"], &id) == nil && validInviteID(id) {
			extra["id"] = id
		}
	}
	if reg.name != clientsService {
		return reg.out.push(opRefusal(op, extra, refusedNotGoat))
	}
	switch op {
	case clientsOpName:
		return d.opClients(reg, b, extra)
	case inviteOpName:
		return d.opInvite(reg, b, extra)
	default:
		return d.opCancel(reg, b, extra)
	}
}

func (d *Daemon) opClients(reg *serviceReg, b []byte, extra map[string]any) (*holderEntry, bool) {
	refuse := func(reason string) (*holderEntry, bool) { return reg.out.push(opRefusal(clientsOpName, extra, reason)) }
	var o opClients
	if err := exact(b, &o); err != nil || o.Clients == nil {
		return refuse("the op's members are not exactly op, gen and clients")
	}
	gen, ok := positiveInteger(o.Gen)
	if !ok {
		return refuse("gen is not an integer from 1 to 2^53-1")
	}
	if len(o.Clients) > maxClients {
		return refuse("a list holds at most 8 clients")
	}
	list := map[string]string{}
	ids := map[string]bool{}
	for _, raw := range o.Clients {
		var c opClient
		if err := exact(raw, &c); err != nil {
			return refuse("a client is not exactly id and noisePub")
		}
		if !validID(c.ID) || ids[c.ID] {
			return refuse("a client id is not 26 base32 characters, or repeats")
		}
		if _, ok := decodeKey32(c.NoisePub); !ok {
			return refuse("a client key is not canonical base64url")
		}
		if _, dup := list[c.NoisePub]; dup {
			return refuse("a client key repeats")
		}
		ids[c.ID], list[c.NoisePub] = true, c.ID
	}
	// The view is read under d.mu, which the member sweep also holds, right before the swap (contract "Admission of
	// client keys": a key that is a member, or was one, is never a client).
	d.mu.Lock()
	if reason := d.notClientKeyLocked(list); reason != "" {
		d.mu.Unlock()
		return refuse(reason)
	}
	e, ok, reason, unconfirmed, handshakes := d.svc.setClients(reg, uint64(gen), list)
	var mine []*live
	var waits []chan struct{}
	if ok {
		mine, waits = d.dropClientsLocked(reg, list)
	}
	d.mu.Unlock()
	if reason != "" {
		return refuse(reason)
	}
	if !ok {
		return nil, false
	}
	// The answer is written only after every session of a dropped key and its delivery are closed.
	d.closeAndWait(mine, waits)
	if d.opt.ClientsWaiting != nil {
		d.opt.ClientsWaiting(len(handshakes))
	}
	closeHandshakes(unconfirmed, handshakes)
	e.fill(jsonLine(map[string]any{"t": "clients", "gen": gen}))
	return e, true
}

// notClientKeyLocked says why a key in list cannot be a client: this node's key, a member's, or a revoked member's.
// d.mu is held.
func (d *Daemon) notClientKeyLocked(list map[string]string) string {
	v := d.view()
	self := ident.B64.EncodeToString(d.id.NoisePub)
	for key := range list {
		pub, _ := ident.DecodeKey(key)
		if key == self {
			return "a client key is this node's key"
		}
		if _, member := v.MemberByNoise(pub); member {
			return "a client key is a member's"
		}
		for _, m := range v.Revoked {
			if m.NoisePub == key {
				return "a client key is a revoked member's"
			}
		}
	}
	return ""
}

// setClients replaces reg's list when gen rises, reserving the answer's place in the holder's order. It also returns
// the unconfirmed client handshakes of keys the list dropped, to close, and the done signals of every client handshake
// of a dropped key to wait for: one that confirmed but has no session yet is refused by its own check, after the swap.
func (b *serviceBook) setClients(reg *serviceReg, gen uint64, list map[string]string) (*holderEntry, bool, string, []relay.Conn, []chan struct{}) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if reg.ended || b.byName[reg.name] != reg {
		return nil, false, refusedReplaced, nil, nil
	}
	if gen <= reg.gen {
		return nil, false, "gen does not rise above the last list applied on this registration", nil, nil
	}
	e, ok := reg.out.reserve()
	if !ok {
		return nil, false, "", nil, nil
	}
	reg.gen, reg.clients = gen, list
	unconfirmed, done := reg.handshakesLocked(func(hs *handshake) bool {
		_, kept := list[hs.key]
		return !hs.pairing && !kept
	})
	return e, true, "", unconfirmed, done
}

func (d *Daemon) opInvite(reg *serviceReg, b []byte, extra map[string]any) (*holderEntry, bool) {
	refuse := func(reason string) (*holderEntry, bool) { return reg.out.push(opRefusal(inviteOpName, extra, reason)) }
	var o opInvite
	if err := exact(b, &o); err != nil {
		return refuse("the op's members are not exactly op, id, psk and expiresAt")
	}
	if !validInviteID(o.ID) {
		return refuse("the invite id is not 16 base64url characters")
	}
	psk, ok := decodeKey32(o.PSK)
	if !ok {
		return refuse("the psk is not canonical base64url of 32 bytes")
	}
	at, ok := positiveInteger(o.ExpiresAt)
	if !ok {
		return refuse("expiresAt is not an integer of milliseconds")
	}
	expires := time.UnixMilli(at)
	inv := &serviceInvite{id: o.ID, psk: psk, expires: expires, budget: inviteBudget}
	d.svc.mu.Lock()
	defer d.svc.mu.Unlock()
	if now := d.now(); !expires.After(now) || expires.Sub(now) > maxInviteAhead {
		return reg.out.push(opRefusal(inviteOpName, extra, "expiresAt is not within the next 10 minutes"))
	}
	if reg.ended || d.svc.byName[reg.name] != reg {
		return reg.out.push(opRefusal(inviteOpName, extra, refusedReplaced))
	}
	if reg.invite != nil && reg.invite.id == o.ID {
		return reg.out.push(opRefusal(inviteOpName, extra, "the registration holds an invite with this id"))
	}
	e, ok := reg.out.push(jsonLine(map[string]any{"t": "invite", "id": o.ID}))
	if ok {
		reg.invite = inv
	}
	return e, ok
}

func (d *Daemon) opCancel(reg *serviceReg, b []byte, extra map[string]any) (*holderEntry, bool) {
	var o opCancel
	if err := exact(b, &o); err != nil || !validInviteID(o.ID) {
		return reg.out.push(opRefusal(cancelOpName, extra, "the op's members are not exactly op and a 16-character id"))
	}
	d.svc.mu.Lock()
	defer d.svc.mu.Unlock()
	now := d.now()
	was := "absent"
	if inv := reg.invite; inv != nil && inv.id == o.ID {
		switch {
		case inv.burned:
			was = "burned"
		case now.Before(inv.expires):
			was = "live"
		}
		reg.invite = nil
	}
	return reg.out.push(jsonLine(map[string]any{"t": "invite-cancelled", "id": o.ID, "was": was}))
}

// liftOpLimit lets a registration's connection carry ops for as long as it lives; each op line has its own cap.
func liftOpLimit(lr *io.LimitedReader) { lr.N = math.MaxInt64 }
