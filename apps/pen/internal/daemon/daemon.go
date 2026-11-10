// Package daemon is the pen node: it holds the uplink, answers sessions, keeps the mesh in sync and
// serves the local control socket.
package daemon

import (
	"context"
	"errors"
	"fmt"
	"log"
	"maps"
	"os"
	"sync"
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
	// PushTimeout bounds one push to a member (30 s); a push that runs out of it marks the member
	// offline.
	PushTimeout time.Duration
	// HostKeysEvery is the host key check interval (1 hour).
	HostKeysEvery time.Duration
	// SSHUser is the login name published in hostkeys records; "" reads it from os/user, "none"
	// publishes none.
	SSHUser string
	// OnView runs after known_hosts is rewritten for a new view (pen keeps its ssh config current there).
	OnView func(*mesh.View) error
	// AccountWait bounds the wait for an account joiner's assertion and card (10 s).
	AccountWait time.Duration
	// Announce is the version this node announces in sync hellos (mesh.Version); tests set "-" to
	// act as a v1.0 node, which announces none.
	Announce string
	// RetryAfter waits between registry forget retries (time.After); tests drive it.
	RetryAfter func(time.Duration) <-chan time.Time
	// OnForget, when set, is told each registry forget attempt and whether it stays queued.
	OnForget func(nodeID string, err error, kept bool)
	// Ready is called once the control socket accepts requests.
	Ready func()
	Now   func() time.Time
	// Since is the monotonic time elapsed since a Now reading (time.Since); a wall clock that ran
	// ahead of it means the machine slept (wake.go).
	Since func(time.Time) time.Duration
	// WakeTicks paces the sleep check (every 5 s when nil); tests drive it.
	WakeTicks <-chan time.Time
	// PresenceEvery spaces the presence syncs a polled dashboard starts (30 s).
	PresenceEvery time.Duration
	// PresenceDone, when set, is told each finished presence sync (tests).
	PresenceDone func()
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
	pending *pendingBook
	forgets *forgetBook

	// accept receives the sessions of every uplink; slots holds one uplink per relay.
	accept chan relay.Conn
	upMu   sync.Mutex
	slots  []*uplinkSlot
	halted string // set once the uplinks are down for good ("stopped", "left")
	runCtx context.Context

	mu       sync.Mutex
	sessions map[uint64]*live
	nextLive uint64
	watchers map[chan []byte]struct{}
	seen     map[string]seenInfo
	// versions is what each peer (by Noise key) announced in its last sync hello, kept in
	// versions.json so an offline member's last announcement still counts.
	versions map[string]string
	// acct are the running kind 0x04 sessions, oldest first.
	acct       []*acctSlot
	inviteWait map[string]chan mesh.Member
	lastView   *mesh.View

	khMu sync.Mutex
	// sshUser is published in this node's hostkeys records.
	sshUser string

	// dash is the running dashboard (nil when none); dashClosed refuses new ones once Run ends.
	dashMu     sync.Mutex
	dash       *dashboard
	dashClosed bool

	// presence paces the syncs a polled dashboard starts so its online column stays true.
	presenceMu      sync.Mutex
	presenceAt      time.Time
	presenceRunning bool

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
	// Relay carried the member's last session with this node.
	Relay string
}

// LeftMarker is written by pen leave; pen up --foreground (a service restart) then refuses to start.
const LeftMarker = "left"

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
	if opt.PresenceEvery == 0 {
		opt.PresenceEvery = 30 * time.Second
	}
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.Since == nil {
		opt.Since = time.Since
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
	if err := CheckConfig(cfg); err != nil {
		return nil, err
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
	pending, err := loadPending(st)
	if err != nil {
		return nil, err
	}
	versions, err := loadVersions(st)
	if err != nil {
		return nil, err
	}
	forgets, err := loadForgets(st)
	if err != nil {
		return nil, err
	}
	d := &Daemon{
		opt: opt, st: st, id: id, nodeID: id.NodeID(), cfg: cfg, store: store, invites: invites, pending: pending, forgets: forgets,
		sessions: map[uint64]*live{}, watchers: map[chan []byte]struct{}{}, seen: map[string]seenInfo{},
		versions: versions, inviteWait: map[string]chan mesh.Member{}, stopCh: make(chan struct{}),
	}
	switch opt.SSHUser {
	case "":
		d.sshUser = LoginUser()
	case "none":
	default:
		if !mesh.ValidUser(opt.SSHUser) {
			return nil, fmt.Errorf("invalid ssh user %q", opt.SSHUser)
		}
		d.sshUser = opt.SSHUser
	}
	d.accept = make(chan relay.Conn, 64)
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

// relays is the node's relay list.
func (d *Daemon) relays() []string {
	d.cfgMu.Lock()
	defer d.cfgMu.Unlock()
	return d.cfg.RelayList()
}

// relayURL is the first relay (shown where one relay is expected).
func (d *Daemon) relayURL() string {
	if r := d.relays(); len(r) > 0 {
		return r[0]
	}
	return ""
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
	// A redirect file left by a daemon that died holds a token nobody serves.
	os.Remove(d.st.Path(DashboardFile))
	d.capLog()
	d.pruneInvites()
	d.spawn(func() { d.serveControl(ctx, ln) })
	d.startUplinks()
	d.spawn(func() { d.acceptLoop(ctx) })
	d.spawn(func() { d.every(ctx, d.opt.SyncEvery, func() { d.pushAll(ctx) }) })
	d.spawn(func() {
		d.every(ctx, logCapEvery, func() {
			d.capLog()
			d.pruneInvites()
		})
	})
	d.spawn(func() { d.hostKeysLoop(ctx) })
	d.spawn(func() { d.forgetLoop(ctx) })
	d.spawn(func() { d.wakeLoop(ctx) })
	d.writeKnownHosts()
	if d.opt.Ready != nil {
		d.opt.Ready()
	}
	select {
	case <-ctx.Done():
	case <-d.stopCh:
	}
	d.stopDashboard(true)
	d.stopUplinks("stopped")
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
	if err := d.st.WriteJSON("daemon.json", daemonJSON{PID: os.Getpid(), Started: started.UnixMilli(), Uplink: d.uplinkState()}, 0o600); err != nil {
		d.opt.Logf("daemon.json: %v", err)
	}
}

// uplinkSlot is the uplink to one relay.
type uplinkSlot struct {
	url    string
	up     *relay.Uplink
	cancel context.CancelFunc
	mu     sync.Mutex
	state  string
	rtt    time.Duration
	rttAt  time.Time
}

func (sl *uplinkSlot) set(state string) {
	sl.mu.Lock()
	sl.state = state
	sl.mu.Unlock()
}

func (sl *uplinkSlot) get() string {
	sl.mu.Lock()
	defer sl.mu.Unlock()
	return sl.state
}

func (sl *uplinkSlot) setRTT(rtt time.Duration, at time.Time) {
	sl.mu.Lock()
	sl.rtt, sl.rttAt = rtt, at
	sl.mu.Unlock()
}

// startUplinks (re)connects one uplink per relay.
func (d *Daemon) startUplinks() {
	d.upMu.Lock()
	defer d.upMu.Unlock()
	for _, sl := range d.slots {
		sl.cancel()
	}
	d.slots, d.halted = nil, ""
	for _, url := range d.relays() {
		ctx, cancel := context.WithCancel(d.runCtx)
		sl := &uplinkSlot{url: url, cancel: cancel, state: "connecting"}
		sl.up = relay.NewUplinkInto(url, d.id, d.accept)
		sl.up.Logf = func(format string, args ...any) { d.opt.Logf(url+": "+format, args...) }
		sl.up.OnState = func(up bool) { d.onUplink(sl, up) }
		sl.up.OnPong = func(rtt time.Duration) { sl.setRTT(rtt, d.now()) }
		d.slots = append(d.slots, sl)
		d.spawn(func() {
			err := sl.up.Run(ctx)
			if errors.Is(err, relay.ErrReplaced) {
				d.opt.Logf("%s: uplink replaced by another pen for this node (4409); not reconnecting until pen up", url)
				sl.set("replaced")
				d.writeDaemonJSON(d.now())
			}
		})
	}
}

// stopUplinks ends every uplink for good.
func (d *Daemon) stopUplinks(why string) {
	d.upMu.Lock()
	defer d.upMu.Unlock()
	for _, sl := range d.slots {
		sl.cancel()
	}
	d.halted = why
}

func (d *Daemon) onUplink(sl *uplinkSlot, up bool) {
	if up {
		sl.set("up")
		d.spawn(func() { d.pushAll(d.runCtx) })
	} else if sl.get() == "up" {
		sl.set("connecting")
	}
	d.writeDaemonJSON(d.now())
}

// RelayState is one relay's uplink and its last ping round trip.
type RelayState struct {
	URL    string `json:"url"`
	Uplink string `json:"uplink"`
	RTTMs  int64  `json:"rttMs,omitempty"`
	RTTAt  int64  `json:"rttAt,omitempty"`
}

func (d *Daemon) relayStates() []RelayState {
	d.upMu.Lock()
	defer d.upMu.Unlock()
	out := make([]RelayState, 0, len(d.slots))
	for _, sl := range d.slots {
		sl.mu.Lock()
		r := RelayState{URL: sl.url, Uplink: sl.state}
		if !sl.rttAt.IsZero() {
			r.RTTMs, r.RTTAt = max(sl.rtt.Milliseconds(), 1), sl.rttAt.UnixMilli()
		}
		sl.mu.Unlock()
		if d.halted != "" {
			r.Uplink = d.halted
		}
		out = append(out, r)
	}
	return out
}

// uplinkState is "up" when any uplink is up, else the best state among them.
func (d *Daemon) uplinkState() string {
	d.upMu.Lock()
	halted, slots := d.halted, d.slots
	d.upMu.Unlock()
	if halted != "" {
		return halted
	}
	best := "stopped"
	for _, sl := range slots {
		switch s := sl.get(); {
		case s == "up":
			return "up"
		case s == "connecting":
			best = s
		case s == "replaced" && best == "stopped":
			best = s
		}
	}
	return best
}

// anyReplaced reports an uplink that a newer one replaced (4409).
func (d *Daemon) anyReplaced() bool {
	for _, r := range d.relayStates() {
		if r.Uplink == "replaced" {
			return true
		}
	}
	return false
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

// markSeen records a member's session state; via is the relay that carried it ("" keeps the last).
func (d *Daemon) markSeen(noisePub []byte, online bool, via string) {
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
	if via != "" {
		s.Relay = via
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
	old := d.lastView
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
	d.forgetRevoked(old, v)
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

// helloFrom records the version a peer announces in its sync hello.
func (d *Daemon) helloFrom(noisePub []byte) mesh.Hello {
	k := ident.B64.EncodeToString(noisePub)
	return func(pen string) {
		d.mu.Lock()
		changed := d.versions[k] != pen
		d.versions[k] = pen
		var snapshot map[string]string
		if changed {
			snapshot = maps.Clone(d.versions)
		}
		d.mu.Unlock()
		if changed {
			if err := d.saveVersions(snapshot); err != nil {
				d.opt.Logf("%s: %v", VersionsFile, err)
			}
		}
	}
}

// announce is the version this node puts in its sync hellos.
func (d *Daemon) announce() string {
	switch d.opt.Announce {
	case "":
		return mesh.Version
	case "-":
		return ""
	}
	return d.opt.Announce
}
