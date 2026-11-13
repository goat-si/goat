package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"slices"
	"sync"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

// Request is one control request line.
type Request struct {
	Op          string `json:"op"`
	TTLMs       int64  `json:"ttlMs,omitempty"`
	Wait        bool   `json:"wait,omitempty"`
	Subject     string `json:"subject,omitempty"`
	Compromised bool   `json:"compromised,omitempty"`
	Token       string `json:"token,omitempty"`
	Name        string `json:"name,omitempty"`
	// Account is a login-bind's binding; On is a lock's state.
	Account *mesh.Account `json:"account,omitempty"`
	On      bool          `json:"on,omitempty"`
	// Relays is the new relay list of op "relays".
	Relays []string `json:"relays,omitempty"`
	// Port and Key are a service.register's loopback port and base64url key.
	Port int    `json:"port,omitempty"`
	Key  string `json:"key,omitempty"`
}

// LsMember is a member as ls reports it.
type LsMember struct {
	mesh.Member
	Fingerprint    string `json:"fingerprint"`
	Self           bool   `json:"self"`
	Online         bool   `json:"online"`
	LastSeen       int64  `json:"lastSeen,omitempty"`
	AdmittedByName string `json:"admittedByName,omitempty"`
	// Relay carried the member's last session with this node (mesh sync or accepted session).
	Relay string `json:"relay,omitempty"`
	// Traffic24h is the stream bytes of the last 24 hours with this member (traffic.go); absent when none.
	Traffic24h *MemberTraffic `json:"traffic24h,omitempty"`
}

// LsRevoked is a revoked key as ls reports it, with the bytes it carried in the last 24 hours (absent when none).
type LsRevoked struct {
	mesh.Member
	Traffic24h *MemberTraffic `json:"traffic24h,omitempty"`
}

// LsReply is the ls answer.
type LsReply struct {
	Self    string      `json:"self"`
	MeshID  string      `json:"meshId"`
	Relay   string      `json:"relay"`
	Uplink  string      `json:"uplink"`
	Members []LsMember  `json:"members"`
	Revoked []LsRevoked `json:"revoked"`
	// Account is the mesh's Google account binding (nil when unbound); Locked is lock mode;
	// Pending counts requests waiting for this node's approval.
	Account *mesh.Account `json:"account,omitempty"`
	Locked  bool          `json:"locked"`
	Pending int           `json:"pending"`
	// Unforgotten are revoked machines the login service still offers to new machines because it
	// refused this node's forget (this node is not registered under the account).
	Unforgotten []Unforgotten `json:"unforgotten,omitempty"`
	// SaveError is the last failed save of the mesh ("" once one succeeds); Records counts the
	// mesh's records, against the caps.
	SaveError string `json:"saveError,omitempty"`
	Records   int    `json:"records"`
	// HostKeysError names sshd public key files that exist but could not be read, and the fix.
	HostKeysError string `json:"hostKeysError,omitempty"`
	// Relays24h is the stream bytes of the last 24 hours per relay, every member and revoked key together;
	// TrafficSince (ms) is where those totals start. Both are absent while nothing was counted.
	Relays24h    []RelayTraffic `json:"relays24h,omitempty"`
	TrafficSince int64          `json:"trafficSince,omitempty"`
	// StateDir is this machine's state folder, filled in by the command line for its advice.
	StateDir string `json:"-"`
}

// Unforgotten is a revoked machine the login service still lists.
type Unforgotten struct {
	NodeID   string `json:"nodeId"`
	Name     string `json:"name"`
	LoginURL string `json:"loginUrl"`
}

// WatchLine is one view change.
type WatchLine struct {
	T       string    `json:"t"`
	At      int64     `json:"at"`
	Members []NameRef `json:"members"`
	Revoked []NameRef `json:"revoked"`
}

// NameRef names a node.
type NameRef struct {
	NodeID string `json:"nodeId"`
	Name   string `json:"name"`
}

func refs(ms []mesh.Member) []NameRef {
	out := make([]NameRef, 0, len(ms))
	for _, m := range ms {
		out = append(out, NameRef{NodeID: m.NodeID, Name: m.Name})
	}
	return out
}

func watchLine(v *mesh.View, at time.Time) []byte {
	b, _ := json.Marshal(WatchLine{T: "view", At: at.UnixMilli(), Members: refs(v.SortedMembers()), Revoked: refs(v.SortedRevoked())})
	return append(b, '\n')
}

// SocketPath is the control socket in a state directory.
func SocketPath(st *state.Store) string { return st.Path("control.sock") }

func (d *Daemon) listenControl() (net.Listener, error) {
	p := SocketPath(d.st)
	os.Remove(p)
	ln, err := net.Listen("unix", p)
	if err != nil {
		return nil, fmt.Errorf("control socket: %w", err)
	}
	if err := state.RestrictFile(p); err != nil {
		ln.Close()
		return nil, err
	}
	return ln, nil
}

// controlConnCap bounds the control connections open at once, long-lived ones (watches, registrations) and ended
// registrations still draining included; controlRequestTimeout bounds the wait for a connection's request line, and
// controlWriteTimeout each write to a client, so one that stops reading frees its slot (variables for tests).
var (
	controlConnCap        = 512
	controlRequestTimeout = 10 * time.Second
	controlWriteTimeout   = 5 * time.Second
)

// boundedConn gives every write its own deadline; closed runs after its Close and frees its control slot.
type boundedConn struct {
	net.Conn
	closed func()
}

func (b boundedConn) Write(p []byte) (int, error) {
	if err := b.Conn.SetWriteDeadline(time.Now().Add(controlWriteTimeout)); err != nil {
		return 0, err
	}
	return b.Conn.Write(p)
}

// CloseWrite half-closes the connection when the one it wraps can.
func (b boundedConn) CloseWrite() error {
	if cw, ok := b.Conn.(interface{ CloseWrite() error }); ok {
		return cw.CloseWrite()
	}
	return errors.ErrUnsupported
}

func (b boundedConn) Close() error {
	err := b.Conn.Close()
	b.closed()
	return err
}

func (d *Daemon) serveControl(ctx context.Context, ln net.Listener) {
	slots := make(chan struct{}, controlConnCap)
	d.controlSlots = slots
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		select {
		case slots <- struct{}{}:
		default:
			c.Close()
			continue
		}
		// The slot is freed when the connection closes, which for a registration's holder may be after
		// handleControl returns (holderQueue.failWith).
		d.spawn(func() { d.handleControl(ctx, boundedConn{c, sync.OnceFunc(func() { <-slots })}) })
	}
}

func (d *Daemon) handleControl(ctx context.Context, c net.Conn) {
	// A registration's holder queue ends its connection itself, after its last line (holderQueue.failWith).
	owned := false
	defer func() {
		if !owned {
			c.Close()
		}
	}()
	lr := &io.LimitedReader{R: c, N: 64 << 10}
	r := bufio.NewReader(lr)
	if c.SetReadDeadline(time.Now().Add(controlRequestTimeout)) != nil {
		return
	}
	line, err := r.ReadBytes('\n')
	if err != nil || c.SetReadDeadline(time.Time{}) != nil {
		return
	}
	enc := json.NewEncoder(c)
	reply := func(v any) { enc.Encode(v) }
	fail := func(err error) { reply(map[string]string{"error": err.Error()}) }
	// Control socket only, like the ops below: the dashboard reaches do, never handleControl.
	if boundOp(line) {
		d.controlBound(ctx, c, line, reply, fail)
		return
	}
	var req Request
	if err := json.Unmarshal(line, &req); err != nil {
		enc.Encode(map[string]string{"error": "bad request"})
		return
	}
	switch req.Op {
	case "watch":
		d.controlWatch(ctx, c)
		return
	// These two run on the control socket only: the dashboard reaches do, never handleControl.
	case "service.register":
		owned = d.controlRegister(ctx, c, r, lr, req, reply, fail)
		return
	case "watch.snapshot":
		d.controlSnapshot(ctx, c, fail)
		return
	case "traffic.report":
		if res, err := d.reportTraffic(line); err != nil {
			fail(err)
		} else {
			reply(res)
		}
		return
	case "invite":
		if req.Wait {
			d.controlInvite(ctx, c, req, reply, fail)
			return
		}
	}
	res, err := d.do(ctx, req)
	if err != nil {
		fail(err)
		return
	}
	reply(res)
	if req.Op == "stop" || req.Op == "leave" {
		d.Stop()
	}
}

// do runs one non-streaming control op; the control socket and the dashboard both call it.
func (d *Daemon) do(ctx context.Context, req Request) (any, error) {
	switch req.Op {
	case "status":
		s := d.status()
		s.Features = Features
		return s, nil
	case "ls":
		return d.ls(), nil
	case "invite":
		r, _, err := d.createInvite(req.TTLMs)
		return r, err
	case "push":
		return map[string]any{"results": d.pushAll(ctx)}, nil
	case "revoke":
		res, err := d.revoke(ctx, req.Subject, req.Compromised)
		if err != nil {
			return nil, err
		}
		return map[string]any{"results": res}, nil
	case "leave":
		// A leave runs to its end even when its client stops waiting (pen leave says it is still in
		// progress, and a later pen leave finishes the cleanup), so a second one only says so.
		if !d.leaving.CompareAndSwap(false, true) {
			return nil, errors.New("this node is already leaving its mesh; run pen leave again once that has finished")
		}
		res, err := d.leave(ctx)
		if err != nil {
			d.leaving.Store(false)
			return nil, err
		}
		return map[string]any{"results": res}, nil
	case "join":
		if err := d.join(ctx, req.Token, req.Name); err != nil {
			return nil, err
		}
		return d.ls(), nil
	case "name":
		if err := d.rename(ctx, req.Name); err != nil {
			return nil, err
		}
		return d.status(), nil
	case "reconnect":
		cfg, err := d.st.LoadConfig()
		if err != nil {
			return nil, err
		}
		d.cfgMu.Lock()
		changed := len(cfg.RelayList()) > 0 && !slices.Equal(cfg.RelayList(), d.cfg.RelayList())
		if changed {
			d.cfg.SetRelays(cfg.RelayList())
		}
		d.cfgMu.Unlock()
		if changed || d.anyReplaced() {
			d.startUplinks()
		}
		return d.status(), nil
	case "stop":
		return map[string]bool{"ok": true}, nil
	case "login-bind", "account-unbind":
		acct := req.Account
		if req.Op == "account-unbind" {
			acct = nil
		} else if acct == nil {
			return nil, errors.New("login-bind needs an account")
		}
		res, err := d.bindAccount(ctx, acct)
		if err != nil {
			return nil, err
		}
		return map[string]any{"results": res, "status": d.status()}, nil
	case "lock":
		res, err := d.setLock(ctx, req.On)
		if err != nil {
			return nil, err
		}
		return map[string]any{"results": res, "locked": d.view().Locked}, nil
	case "pending":
		return map[string]any{"pending": d.pending.all(d.now())}, nil
	case "approve":
		return d.approve(ctx, req.Subject)
	case "deny":
		p, err := d.deny(req.Subject)
		if err != nil {
			return nil, err
		}
		return map[string]any{"denied": p}, nil
	case "adopt":
		if err := d.adopt(ctx); err != nil {
			return nil, err
		}
		return d.ls(), nil
	case "relays":
		return d.setRelays(req.Relays)
	case "dashboard":
		return d.openDashboard()
	case "dashboard-stop":
		return map[string]bool{"stopped": d.stopDashboard(false)}, nil
	}
	return nil, fmt.Errorf("unknown op %q", req.Op)
}

// Status is the status answer.
type Status struct {
	NodeID      string       `json:"nodeId"`
	Fingerprint string       `json:"fingerprint"`
	Name        string       `json:"name"`
	Relay       string       `json:"relay"`
	Relays      []RelayState `json:"relays"`
	Uplink      string       `json:"uplink"`
	MeshID      string       `json:"meshId"`
	Members     int          `json:"members"`
	PID         int          `json:"pid"`
	// Features lists what this node supports beyond its version's base (contract "Bound invites"). Only the status op
	// carries it: name, reconnect, relays, login-bind and account-unbind answer with the same struct and keep their shape.
	Features []string `json:"features,omitempty"`
}

func (d *Daemon) status() Status {
	v := d.view()
	name := v.Members[ident.B64.EncodeToString(d.id.SignPub)].Name
	return Status{NodeID: d.nodeID, Fingerprint: ident.Fingerprint(d.id.NoisePub), Name: name, Relay: d.relayURL(),
		Relays: d.relayStates(), Uplink: d.uplinkState(), MeshID: v.MeshID, Members: len(v.Members), PID: os.Getpid()}
}

func (d *Daemon) ls() LsReply {
	v := d.view()
	s := d.uplinkState()
	out := LsReply{Self: d.nodeID, MeshID: v.MeshID, Relay: d.relayURL(), Uplink: s,
		Account: v.Account, Locked: v.Locked, Pending: len(d.pending.all(d.now())), Records: d.mesh().Len()}
	d.mu.Lock()
	if d.saveErr != nil {
		out.SaveError = d.saveErr.Error()
	}
	out.HostKeysError = d.hostKeysErr
	d.mu.Unlock()
	perMember, relays, since := d.trafficTotals()
	out.Relays24h, out.TrafficSince = relays, since
	out.Revoked = make([]LsRevoked, 0, len(v.Revoked))
	for _, m := range v.SortedRevoked() {
		out.Revoked = append(out.Revoked, LsRevoked{Member: m, Traffic24h: perMember[m.NodeID]})
	}
	for _, f := range d.forgets.refusedList() {
		u := Unforgotten{NodeID: f.NodeID, LoginURL: f.LoginURL}
		if m, ok := v.RevokedByNodeID(f.NodeID); ok {
			u.Name = m.Name
		}
		out.Unforgotten = append(out.Unforgotten, u)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, m := range v.SortedMembers() {
		noise, _ := ident.DecodeKey(m.NoisePub)
		lm := LsMember{Member: m, Fingerprint: ident.Fingerprint(noise), Self: m.NodeID == d.nodeID, Traffic24h: perMember[m.NodeID]}
		if a, ok := v.Members[m.AdmittedBy]; ok {
			lm.AdmittedByName = a.Name
		} else if a, ok := v.Revoked[m.AdmittedBy]; ok {
			lm.AdmittedByName = a.Name
		}
		if lm.Self {
			lm.Online = s == "up"
		} else if seen, ok := d.seen[m.SignPub]; ok {
			lm.Online = seen.Online
			lm.Relay = seen.Relay
			if !seen.At.IsZero() {
				lm.LastSeen = seen.At.UnixMilli()
			}
		}
		out.Members = append(out.Members, lm)
	}
	return out
}

// InviteReply is what an invite answers.
type InviteReply struct {
	Token     string `json:"token"`
	Relay     string `json:"relay"`
	ExpiresAt int64  `json:"expiresAt"`
	// Command installs pen on the new machine and joins (from the download relay).
	Command string `json:"command"`
	// WindowsCommand does the same from PowerShell on Windows.
	WindowsCommand string `json:"windowsCommand"`
	// ID is a bound invite's id (contract "Bound invites"); an ordinary invite's answer has none.
	ID string `json:"id,omitempty"`
	// MintID repeats a bound invite's mintId.
	MintID string `json:"mintId,omitempty"`
}

func (d *Daemon) createInvite(ttlMs int64) (InviteReply, string, error) {
	return d.createInviteNotify(d.inviteBook(), ttlMs, nil)
}

func (d *Daemon) createInviteNotify(book *mesh.Invites, ttlMs int64, sig *mesh.Signals) (InviteReply, string, error) {
	ttl := time.Duration(ttlMs) * time.Millisecond
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	inv, err := book.CreateNotify(ttl, d.now(), sig)
	if err != nil {
		return InviteReply{}, "", err
	}
	return d.inviteReply(inv), inv.ID, nil
}

func (d *Daemon) inviteReply(inv mesh.Invite) InviteReply {
	tok := mesh.Token{SignPub: d.id.SignPub, NoisePub: d.id.NoisePub, Secret: inv.Secret, Relays: d.relays()}
	s := tok.String()
	return InviteReply{Token: s, Relay: tok.Relays[0], ExpiresAt: inv.ExpiresAt, Command: InstallCommand(d.downloadRelay(), s),
		WindowsCommand: InstallCommandWindows(d.downloadRelay(), s)}
}

func (d *Daemon) controlInvite(ctx context.Context, c net.Conn, req Request, reply func(any), fail func(error)) {
	sig, book := mesh.NewSignals(), d.inviteBook()
	r, id, err := d.createInviteNotify(book, req.TTLMs, sig)
	if err != nil {
		fail(err)
		return
	}
	d.awaitJoin(ctx, c, r, book, id, sig, reply)
}

// awaitJoin answers r, then what became of the invite (a join's outcome, its cancel or its expiry) until the client
// hangs up. sig is the invite's Cancelled and Burned pair, attached when it was made.
func (d *Daemon) awaitJoin(ctx context.Context, c net.Conn, r InviteReply, book *mesh.Invites, id string, sig *mesh.Signals, reply func(any)) {
	wait := make(chan joinOutcome, 1)
	d.mu.Lock()
	d.inviteWait[id] = wait
	d.mu.Unlock()
	defer func() {
		d.mu.Lock()
		delete(d.inviteWait, id)
		d.mu.Unlock()
	}()
	reply(r)
	gone := clientGone(c)
	expiry, stop := inviteExpiry(time.Until(time.UnixMilli(r.ExpiresAt)))
	defer func() { stop() }()
	outcome := func(o joinOutcome) {
		switch {
		case o.delivered:
			reply(map[string]any{"t": "admitted", "member": *o.member})
		case o.member != nil:
			reply(map[string]any{"t": "admitted", "member": *o.member, "delivered": false})
		default:
			reply(map[string]any{"t": "burned"})
		}
	}
waiting:
	for {
		select {
		case o := <-wait:
			outcome(o)
			return
		case <-sig.Cancelled:
			reply(map[string]any{"t": "cancelled"})
			return
		case <-expiry:
			state, left, err := book.WaitExpiry(id, sig, d.now)
			switch {
			case err != nil:
				reply(map[string]string{"error": "could not record the invite's expiry: " + err.Error()})
				return
			case state == mesh.InviteLive:
				// Fired early by the node's clock (it was set back): wait for the time left.
				stop()
				expiry, stop = inviteExpiry(left)
				continue
			case state == mesh.InviteBurned:
				break waiting
			case state == mesh.InviteCancelled:
				reply(map[string]any{"t": "cancelled"})
			default:
				reply(map[string]any{"t": "expired"})
			}
			return
		case <-sig.Burned:
			break waiting
		case <-gone:
			return
		case <-ctx.Done():
			return
		}
	}
	// A join used the invite: its outcome is the answer, for as long as that join may run, counted from here; past
	// that the invite was used and this wait cannot say whom it admitted.
	joinDone, stopJoin := inviteExpiry(meshSessionTimeout)
	defer stopJoin()
	select {
	case o := <-wait:
		outcome(o)
	case <-joinDone:
		reply(map[string]any{"t": "burned"})
	case <-gone:
	case <-ctx.Done():
	}
}

// inviteExpiry is the timer of a wait on an invite; tests fire it by hand.
var inviteExpiry = func(d time.Duration) (<-chan time.Time, func() bool) {
	t := time.NewTimer(d)
	return t.C, t.Stop
}

// clientGone closes when the control client hangs up.
func clientGone(c net.Conn) <-chan struct{} {
	ch := make(chan struct{})
	go func() {
		buf := make([]byte, 1)
		for {
			if _, err := c.Read(buf); err != nil {
				close(ch)
				return
			}
		}
	}()
	return ch
}

func (d *Daemon) controlWatch(ctx context.Context, c net.Conn) {
	ch := make(chan []byte, 16)
	d.mu.Lock()
	d.watchers[ch] = struct{}{}
	first := watchLine(d.lastView, d.now())
	d.mu.Unlock()
	defer func() {
		d.mu.Lock()
		if _, ok := d.watchers[ch]; ok {
			delete(d.watchers, ch)
		}
		d.mu.Unlock()
	}()
	if _, err := c.Write(first); err != nil {
		return
	}
	gone := clientGone(c)
	// A leave queues the view revoking this node and then stops the daemon, which also ends ctx:
	// on either, pass on what is queued before ending.
	drain := func() {
		for {
			select {
			case line, ok := <-ch:
				if !ok {
					return
				}
				if _, err := c.Write(line); err != nil {
					return
				}
			default:
				return
			}
		}
	}
	for {
		select {
		case line, ok := <-ch:
			if !ok {
				return
			}
			if _, err := c.Write(line); err != nil {
				return
			}
		case <-gone:
			return
		case <-ctx.Done():
			drain()
			return
		case <-d.stopCh:
			drain()
			return
		}
	}
}

// Client is a control socket connection.
type Client struct {
	c   net.Conn
	dec *json.Decoder
}

// ErrNotRunning means no daemon answers on the control socket.
var ErrNotRunning = errors.New("the pen daemon is not running (pen up starts it)")

// Dial connects to the daemon of st.
func Dial(st *state.Store) (*Client, error) {
	c, err := net.Dial("unix", SocketPath(st))
	if err != nil {
		return nil, ErrNotRunning
	}
	return &Client{c: c, dec: json.NewDecoder(c)}, nil
}

// Send writes the request line.
func (cl *Client) Send(req Request) error { return json.NewEncoder(cl.c).Encode(req) }

// Next decodes the next reply line into v; a {"error"} line becomes an error.
func (cl *Client) Next(v any) error {
	var raw json.RawMessage
	if err := cl.dec.Decode(&raw); err != nil {
		return err
	}
	var e struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(raw, &e) == nil && e.Error != "" {
		return errors.New(e.Error)
	}
	return json.Unmarshal(raw, v)
}

// Close hangs up.
func (cl *Client) Close() error { return cl.c.Close() }

// Write sends raw bytes after the request (the ops of a service registration).
func (cl *Client) Write(p []byte) (int, error) { return cl.c.Write(p) }

// Rest reads what the node sends after the replies Next decoded, including bytes Next already buffered.
func (cl *Client) Rest() io.Reader { return io.MultiReader(cl.dec.Buffered(), cl.c) }

// CloseWrite tells the node this side sends nothing more; the node still answers what it was sent.
func (cl *Client) CloseWrite() error {
	if u, ok := cl.c.(interface{ CloseWrite() error }); ok {
		return u.CloseWrite()
	}
	return cl.c.Close()
}

// SetDeadline bounds the requests and replies still to come on this connection.
func (cl *Client) SetDeadline(t time.Time) error { return cl.c.SetDeadline(t) }

// ErrWatchDropped is a daemon that took a watch but hung up before its first line, as it does when
// it stops (at the end of a leave, for one).
var ErrWatchDropped = errors.New("the pen daemon hung up before it could watch for revocations (it may be stopping or leaving the mesh); run this again once pen ls answers")

// WatchRevoked follows the daemon's view and sends the first of nodeIDs to be revoked. It returns
// once the daemon holds the watch (its first line came), so no later revoke is missed. Without a
// running daemon it returns a nil channel (which never fires) and no error; a daemon that does not
// send its first line is ErrWatchDropped. stop ends the watch.
func WatchRevoked(st *state.Store, nodeIDs ...string) (revoked <-chan string, stop func(), err error) {
	cl, err := Dial(st)
	if err != nil {
		return nil, func() {}, nil
	}
	revokedIn := func(w WatchLine) (string, bool) {
		for _, r := range w.Revoked {
			if slices.Contains(nodeIDs, r.NodeID) {
				return r.NodeID, true
			}
		}
		return "", false
	}
	var first WatchLine
	if cl.SetDeadline(time.Now().Add(dialTimeout)) != nil || cl.Send(Request{Op: "watch"}) != nil ||
		cl.Next(&first) != nil || cl.SetDeadline(time.Time{}) != nil {
		cl.Close()
		return nil, func() {}, ErrWatchDropped
	}
	ch := make(chan string, 1)
	if id, ok := revokedIn(first); ok {
		cl.Close()
		ch <- id
		return ch, func() {}, nil
	}
	go func() {
		for {
			var w WatchLine
			if cl.Next(&w) != nil {
				return
			}
			if id, ok := revokedIn(w); ok {
				ch <- id
				return
			}
		}
	}()
	return ch, func() { cl.Close() }, nil
}

// Call sends one request and decodes one reply.
func Call(st *state.Store, req Request, v any) error {
	cl, err := Dial(st)
	if err != nil {
		return err
	}
	defer cl.Close()
	if err := cl.Send(req); err != nil {
		return err
	}
	return cl.Next(v)
}

// CallWithin is Call that waits at most d for the answer once the request is sent (and dialTimeout
// to connect): a daemon that takes the connection but never answers cannot hold the caller. The
// request itself always goes out, so the daemon may still act on it after the caller gave up.
func CallWithin(st *state.Store, req Request, v any, d time.Duration) error {
	c, err := (&net.Dialer{Timeout: dialTimeout}).Dial("unix", SocketPath(st))
	if err != nil {
		return ErrNotRunning
	}
	cl := &Client{c: c, dec: json.NewDecoder(c)}
	defer cl.Close()
	if err := c.SetWriteDeadline(time.Now().Add(sendTimeout)); err != nil {
		return err
	}
	// The daemon acts only on a whole request line, ending in its newline. A write that failed before
	// the last byte left it no such line (ErrNotSent: nothing changed); one that failed after it may
	// have delivered the line, so it counts as sent and the answer is awaited as usual.
	line, err := json.Marshal(req)
	if err != nil {
		return err
	}
	line = append(line, '\n')
	if n, err := c.Write(line); err != nil && n < len(line) {
		return fmt.Errorf("%w: %w", ErrNotSent, err)
	}
	if err := c.SetDeadline(time.Now().Add(d)); err != nil {
		return err
	}
	return cl.Next(v)
}

// dialTimeout bounds connecting to the control socket and writing a request to it.
const dialTimeout = 2 * time.Second

// sendTimeout bounds writing a request (a variable for tests).
var sendTimeout = dialTimeout

// ErrNotSent wraps a CallWithin failure that came before the request was fully written: the daemon
// did not get it.
var ErrNotSent = errors.New("the request did not reach the daemon")
