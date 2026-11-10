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
}

// LsMember is a member as ls reports it.
type LsMember struct {
	mesh.Member
	Fingerprint    string `json:"fingerprint"`
	Self           bool   `json:"self"`
	Online         bool   `json:"online"`
	LastSeen       int64  `json:"lastSeen,omitempty"`
	AdmittedByName string `json:"admittedByName,omitempty"`
}

// LsReply is the ls answer.
type LsReply struct {
	Self    string        `json:"self"`
	MeshID  string        `json:"meshId"`
	Relay   string        `json:"relay"`
	Uplink  string        `json:"uplink"`
	Members []LsMember    `json:"members"`
	Revoked []mesh.Member `json:"revoked"`
	// Account is the mesh's Google account binding (nil when unbound); Locked is lock mode;
	// Pending counts requests waiting for this node's approval.
	Account *mesh.Account `json:"account,omitempty"`
	Locked  bool          `json:"locked"`
	Pending int           `json:"pending"`
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
	if err := os.Chmod(p, 0o600); err != nil {
		ln.Close()
		return nil, err
	}
	return ln, nil
}

func (d *Daemon) serveControl(ctx context.Context, ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		d.spawn(func() { d.handleControl(ctx, c) })
	}
}

func (d *Daemon) handleControl(ctx context.Context, c net.Conn) {
	defer c.Close()
	r := bufio.NewReader(io.LimitReader(c, 64<<10))
	line, err := r.ReadBytes('\n')
	if err != nil {
		return
	}
	var req Request
	enc := json.NewEncoder(c)
	if err := json.Unmarshal(line, &req); err != nil {
		enc.Encode(map[string]string{"error": "bad request"})
		return
	}
	reply := func(v any) { enc.Encode(v) }
	fail := func(err error) { reply(map[string]string{"error": err.Error()}) }
	switch req.Op {
	case "watch":
		d.controlWatch(ctx, c)
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
		return d.status(), nil
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
		res, err := d.leave(ctx)
		if err != nil {
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
	out := LsReply{Self: d.nodeID, MeshID: v.MeshID, Relay: d.relayURL(), Uplink: s, Revoked: v.SortedRevoked(),
		Account: v.Account, Locked: v.Locked, Pending: len(d.pending.all(d.now()))}
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, m := range v.SortedMembers() {
		noise, _ := ident.DecodeKey(m.NoisePub)
		lm := LsMember{Member: m, Fingerprint: ident.Fingerprint(noise), Self: m.NodeID == d.nodeID}
		if a, ok := v.Members[m.AdmittedBy]; ok {
			lm.AdmittedByName = a.Name
		} else if a, ok := v.Revoked[m.AdmittedBy]; ok {
			lm.AdmittedByName = a.Name
		}
		if lm.Self {
			lm.Online = s == "up"
		} else if seen, ok := d.seen[m.SignPub]; ok {
			lm.Online = seen.Online
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
}

func (d *Daemon) createInvite(ttlMs int64) (InviteReply, string, error) {
	ttl := time.Duration(ttlMs) * time.Millisecond
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	inv, err := d.inviteBook().Create(ttl, d.now())
	if err != nil {
		return InviteReply{}, "", err
	}
	tok := mesh.Token{SignPub: d.id.SignPub, NoisePub: d.id.NoisePub, Secret: inv.Secret, Relays: d.relays()}
	s := tok.String()
	return InviteReply{Token: s, Relay: tok.Relays[0], ExpiresAt: inv.ExpiresAt, Command: InstallCommand(d.downloadRelay(), s)}, inv.ID, nil
}

func (d *Daemon) controlInvite(ctx context.Context, c net.Conn, req Request, reply func(any), fail func(error)) {
	r, id, err := d.createInvite(req.TTLMs)
	if err != nil {
		fail(err)
		return
	}
	wait := make(chan mesh.Member, 1)
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
	t := time.NewTimer(time.Until(time.UnixMilli(r.ExpiresAt)))
	defer t.Stop()
	select {
	case m := <-wait:
		reply(map[string]any{"t": "admitted", "member": m})
	case <-t.C:
		reply(map[string]any{"t": "expired"})
	case <-gone:
	case <-ctx.Done():
	}
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
			return
		case <-d.stopCh:
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

// WatchRevoked follows the daemon's view and closes the returned channel once nodeID is revoked.
// Without a running daemon it returns a nil channel (which never fires); stop ends the watch.
func WatchRevoked(st *state.Store, nodeID string) (revoked <-chan struct{}, stop func()) {
	cl, err := Dial(st)
	if err != nil {
		return nil, func() {}
	}
	if err := cl.Send(Request{Op: "watch"}); err != nil {
		cl.Close()
		return nil, func() {}
	}
	ch := make(chan struct{})
	go func() {
		for {
			var w WatchLine
			if cl.Next(&w) != nil {
				return
			}
			for _, r := range w.Revoked {
				if r.NodeID == nodeID {
					close(ch)
					return
				}
			}
		}
	}()
	return ch, func() { cl.Close() }
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
