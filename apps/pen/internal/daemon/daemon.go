// Package daemon is the pen node: it holds the uplink, answers sessions, keeps the mesh in sync and
// serves the local control socket.
package daemon

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/session"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

// Options configure a daemon. Zero values pick the production defaults.
type Options struct {
	Store *state.Store
	Logf  func(format string, args ...any)
	// HostKeyGlob finds the local sshd public keys; "none" disables host key records.
	HostKeyGlob string
	// KnownHosts is the known_hosts file written from the view; "none" disables it.
	KnownHosts string
	// SyncEvery is the periodic push interval (10 minutes).
	SyncEvery time.Duration
	// HostKeysEvery is the host key check interval (1 hour).
	HostKeysEvery time.Duration
	// Ready is called once the control socket accepts requests.
	Ready func()
	Now   func() time.Time
}

// Daemon is one running node.
type Daemon struct {
	opt    Options
	st     *state.Store
	id     *ident.Identity
	nodeID string

	cfgMu sync.Mutex
	cfg   state.Config

	meshMu  sync.RWMutex
	store   *mesh.Store
	invites *mesh.Invites

	up       *relay.Uplink
	upState  atomic.Value // string
	upCancel context.CancelFunc
	upMu     sync.Mutex
	runCtx   context.Context

	mu         sync.Mutex
	sessions   map[uint64]*live
	nextLive   uint64
	watchers   map[chan []byte]struct{}
	seen       map[string]seenInfo
	inviteWait map[string]chan mesh.Member
	lastView   *mesh.View

	khMu sync.Mutex

	stopOnce sync.Once
	stopCh   chan struct{}
	exitErr  error
	wg       sync.WaitGroup
}

// spawn runs f in a goroutine that Run waits for before it returns.
func (d *Daemon) spawn(f func()) {
	d.wg.Add(1)
	go func() {
		defer d.wg.Done()
		f()
	}()
}

type live struct {
	remote string // Noise static, base64url
	sec    *session.Secure
	// deferred is set on the mesh session that carried its own peer's revoke; it closes itself
	// after its done.
	deferred bool
}

type seenInfo struct {
	At     time.Time
	Online bool
}

// ErrNoIdentity means pen up has not run in this state directory.
var ErrNoIdentity = errors.New("no identity in this state directory; run pen up")

// New loads the node from its state directory. The identity and mesh must exist.
func New(opt Options) (*Daemon, error) {
	if opt.Store == nil {
		return nil, errors.New("daemon: no state store")
	}
	if opt.Logf == nil {
		opt.Logf = log.Printf
	}
	if opt.HostKeyGlob == "" {
		opt.HostKeyGlob = "/etc/ssh/ssh_host_*_key.pub"
	}
	if opt.SyncEvery == 0 {
		opt.SyncEvery = 10 * time.Minute
	}
	if opt.HostKeysEvery == 0 {
		opt.HostKeysEvery = time.Hour
	}
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.KnownHosts == "" {
		p, err := DefaultKnownHosts()
		if err != nil {
			return nil, err
		}
		opt.KnownHosts = p
	}
	st := opt.Store
	id, err := st.LoadIdentity()
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNoIdentity
	}
	if err != nil {
		return nil, err
	}
	cfg, err := st.LoadConfig()
	if err != nil {
		return nil, err
	}
	if cfg.Relay == "" {
		return nil, errors.New("no relay configured; run pen up --relay URL")
	}
	store, err := mesh.Load(st)
	if err != nil {
		return nil, fmt.Errorf("mesh: %w", err)
	}
	store.SetSelf(ident.B64.EncodeToString(id.SignPub))
	invites, err := mesh.LoadInvites(st)
	if err != nil {
		return nil, err
	}
	d := &Daemon{
		opt: opt, st: st, id: id, nodeID: id.NodeID(), cfg: cfg, store: store, invites: invites,
		sessions: map[uint64]*live{}, watchers: map[chan []byte]struct{}{}, seen: map[string]seenInfo{},
		inviteWait: map[string]chan mesh.Member{}, stopCh: make(chan struct{}),
	}
	d.upState.Store("connecting")
	d.up = relay.NewUplink(cfg.Relay, id)
	d.up.Logf = opt.Logf
	d.up.OnState = d.onUplink
	d.lastView = store.View()
	return d, nil
}

// NodeID is this node's id.
func (d *Daemon) NodeID() string { return d.nodeID }

func (d *Daemon) mesh() *mesh.Store {
	d.meshMu.RLock()
	defer d.meshMu.RUnlock()
	return d.store
}

func (d *Daemon) view() *mesh.View { return d.mesh().View() }

func (d *Daemon) inviteBook() *mesh.Invites {
	d.meshMu.RLock()
	defer d.meshMu.RUnlock()
	return d.invites
}

func (d *Daemon) relayURL() string {
	d.cfgMu.Lock()
	defer d.cfgMu.Unlock()
	return d.cfg.Relay
}

func (d *Daemon) now() time.Time { return d.opt.Now() }

// Run serves until ctx ends, the daemon is stopped, or the node leaves.
func (d *Daemon) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	d.runCtx = ctx
	unlock, err := d.lockDaemon()
	if err != nil {
		return err
	}
	defer unlock()
	ln, err := d.listenControl()
	if err != nil {
		return err
	}
	defer func() {
		ln.Close()
		os.Remove(d.st.Path("control.sock"))
	}()
	started := d.now()
	d.writeDaemonJSON(started)
	d.spawn(func() { d.serveControl(ctx, ln) })
	d.startUplink()
	d.spawn(func() { d.acceptLoop(ctx) })
	d.spawn(func() { d.every(ctx, d.opt.SyncEvery, func() { d.pushAll(ctx) }) })
	d.spawn(func() { d.hostKeysLoop(ctx) })
	d.writeKnownHosts()
	if d.opt.Ready != nil {
		d.opt.Ready()
	}
	select {
	case <-ctx.Done():
	case <-d.stopCh:
	}
	d.upMu.Lock()
	if d.upCancel != nil {
		d.upCancel()
	}
	d.upMu.Unlock()
	d.upState.Store("stopped")
	cancel()
	ln.Close()
	d.wg.Wait()
	os.Remove(d.st.Path("daemon.json"))
	return d.exitErr
}

// Stop ends Run.
func (d *Daemon) Stop() { d.stopOnce.Do(func() { close(d.stopCh) }) }

// lockDaemon holds daemon.lock for the daemon's lifetime so only one runs per state directory.
func (d *Daemon) lockDaemon() (func(), error) {
	f, err := os.OpenFile(d.st.Path("daemon.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, errors.New("a pen daemon is already running for this state directory")
	}
	return func() { f.Close() }, nil
}

type daemonJSON struct {
	PID     int    `json:"pid"`
	Started int64  `json:"started"`
	Uplink  string `json:"uplink"`
}

func (d *Daemon) writeDaemonJSON(started time.Time) {
	s, _ := d.upState.Load().(string)
	if err := d.st.WriteJSON("daemon.json", daemonJSON{PID: os.Getpid(), Started: started.UnixMilli(), Uplink: s}, 0o600); err != nil {
		d.opt.Logf("daemon.json: %v", err)
	}
}

func (d *Daemon) startUplink() {
	d.upMu.Lock()
	defer d.upMu.Unlock()
	if d.upCancel != nil {
		d.upCancel()
	}
	ctx, cancel := context.WithCancel(d.runCtx)
	d.upCancel = cancel
	d.up.RelayURL = d.relayURL()
	d.upState.Store("connecting")
	d.spawn(func() {
		err := d.up.Run(ctx)
		if errors.Is(err, relay.ErrReplaced) {
			d.opt.Logf("uplink replaced by another pen for this node (4409); not reconnecting until pen up")
			d.upState.Store("replaced")
			d.writeDaemonJSON(d.now())
		}
	})
}

func (d *Daemon) onUplink(up bool) {
	if up {
		d.upState.Store("up")
		d.spawn(func() { d.pushAll(d.runCtx) })
	} else if s, _ := d.upState.Load().(string); s == "up" {
		d.upState.Store("connecting")
	}
	d.writeDaemonJSON(d.now())
}

func (d *Daemon) every(ctx context.Context, period time.Duration, f func()) {
	t := time.NewTicker(period)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			f()
		}
	}
}

func (d *Daemon) markSeen(noisePub []byte, online bool) {
	m, ok := d.view().MemberByNoise(noisePub)
	if !ok {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	s := d.seen[m.SignPub]
	s.Online = online
	if online {
		s.At = d.now()
	}
	d.seen[m.SignPub] = s
}

// onMerged persists new records and publishes the new view.
func (d *Daemon) onMerged(added []*mesh.Record) {
	if err := d.mesh().Save(); err != nil {
		d.opt.Logf("mesh save: %v", err)
	}
	d.viewChanged()
}

// viewChanged closes sessions of keys that are no longer members, tells watchers, rewrites known_hosts.
func (d *Daemon) viewChanged() {
	v := d.view()
	d.mu.Lock()
	if v == d.lastView {
		d.mu.Unlock()
		return
	}
	d.lastView = v
	var doomed []*live
	for k, l := range d.sessions {
		if l.deferred {
			continue
		}
		pub, _ := ident.DecodeKey(l.remote)
		if _, ok := v.MemberByNoise(pub); !ok {
			doomed = append(doomed, l)
			delete(d.sessions, k)
		}
	}
	line := watchLine(v, d.now())
	for ch := range d.watchers {
		select {
		case ch <- line:
		default:
			close(ch)
			delete(d.watchers, ch)
		}
	}
	d.mu.Unlock()
	for _, l := range doomed {
		l.sec.Close(4401)
	}
	d.writeKnownHosts()
}

// register records a live session unless its peer is no longer a member. The check runs under d.mu,
// which viewChanged's sweep also holds, so a revoke cannot slip between the check and the sweep.
func (d *Daemon) register(l *live) (uint64, bool) {
	pub, _ := ident.DecodeKey(l.remote)
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.view().MemberByNoise(pub); !ok {
		return 0, false
	}
	d.nextLive++
	d.sessions[d.nextLive] = l
	return d.nextLive, true
}

func (d *Daemon) unregister(k uint64) {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.sessions, k)
}
