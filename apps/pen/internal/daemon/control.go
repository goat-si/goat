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
	case "status":
		reply(d.status())
	case "ls":
		reply(d.ls())
	case "invite":
		d.controlInvite(ctx, c, req, reply, fail)
	case "push":
		reply(map[string]any{"results": d.pushAll(ctx)})
	case "watch":
		d.controlWatch(ctx, c)
	case "revoke":
		res, err := d.revoke(ctx, req.Subject, req.Compromised)
		if err != nil {
			fail(err)
			return
		}
		reply(map[string]any{"results": res})
	case "leave":
		res, err := d.leave(ctx)
		if err != nil {
			fail(err)
			return
		}
		reply(map[string]any{"results": res})
		d.Stop()
	case "join":
		if err := d.join(ctx, req.Token, req.Name); err != nil {
			fail(err)
			return
		}
		reply(d.ls())
	case "name":
		if err := d.rename(ctx, req.Name); err != nil {
			fail(err)
			return
		}
		reply(d.status())
	case "reconnect":
		cfg, err := d.st.LoadConfig()
		if err != nil {
			fail(err)
			return
		}
		d.cfgMu.Lock()
		changed := cfg.Relay != "" && cfg.Relay != d.cfg.Relay
		if changed {
			d.cfg.Relay = cfg.Relay
		}
		d.cfgMu.Unlock()
		if s, _ := d.upState.Load().(string); s == "replaced" || changed {
			d.startUplink()
		}
		reply(d.status())
	case "stop":
		reply(map[string]bool{"ok": true})
		d.Stop()
	default:
		fail(fmt.Errorf("unknown op %q", req.Op))
	}
}

// Status is the status answer.
type Status struct {
	NodeID      string `json:"nodeId"`
	Fingerprint string `json:"fingerprint"`
	Name        string `json:"name"`
	Relay       string `json:"relay"`
	Uplink      string `json:"uplink"`
	MeshID      string `json:"meshId"`
	Members     int    `json:"members"`
	PID         int    `json:"pid"`
}

func (d *Daemon) status() Status {
	v := d.view()
	s, _ := d.upState.Load().(string)
	name := v.Members[ident.B64.EncodeToString(d.id.SignPub)].Name
	return Status{NodeID: d.nodeID, Fingerprint: ident.Fingerprint(d.id.NoisePub), Name: name, Relay: d.relayURL(),
		Uplink: s, MeshID: v.MeshID, Members: len(v.Members), PID: os.Getpid()}
}

func (d *Daemon) ls() LsReply {
	v := d.view()
	s, _ := d.upState.Load().(string)
	out := LsReply{Self: d.nodeID, MeshID: v.MeshID, Relay: d.relayURL(), Uplink: s, Revoked: v.SortedRevoked()}
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

func (d *Daemon) controlInvite(ctx context.Context, c net.Conn, req Request, reply func(any), fail func(error)) {
	ttl := time.Duration(req.TTLMs) * time.Millisecond
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	inv, err := d.inviteBook().Create(ttl, d.now())
	if err != nil {
		fail(err)
		return
	}
	tok := mesh.Token{SignPub: d.id.SignPub, NoisePub: d.id.NoisePub, Secret: inv.Secret, Relays: []string{d.relayURL()}}
	var wait chan mesh.Member
	if req.Wait {
		wait = make(chan mesh.Member, 1)
		d.mu.Lock()
		d.inviteWait[inv.ID] = wait
		d.mu.Unlock()
		defer func() {
			d.mu.Lock()
			delete(d.inviteWait, inv.ID)
			d.mu.Unlock()
		}()
	}
	reply(map[string]any{"token": tok.String(), "relay": tok.Relays[0], "expiresAt": inv.ExpiresAt})
	if wait == nil {
		return
	}
	gone := clientGone(c)
	t := time.NewTimer(time.Until(time.UnixMilli(inv.ExpiresAt)))
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
