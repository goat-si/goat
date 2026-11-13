// Package daemon is the pen node: it holds the uplink, answers sessions, keeps the mesh in sync and
// serves the local control socket.
package daemon

import (
	"context"
	"errors"
	"fmt"
	"log"
	"maps"
	"net"
	"os"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/session"
	"github.com/goat-si/goat/apps/pen/internal/state"
	"github.com/goat-si/goat/apps/pen/internal/wire"
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
	// Awake reads a clock that stops while the machine sleeps; a wall clock that ran ahead of it
	// means the machine slept (wake.go). Tests drive it.
	Awake func() time.Duration
	// WakeTicks paces the sleep check (every 5 s when nil); tests drive it.
	WakeTicks <-chan time.Time
	// PresenceEvery spaces the presence syncs a polled dashboard starts (30 s).
	PresenceEvery time.Duration
	// PresenceTimeout bounds each push of a presence refresh (15 s); one that runs out of it marks the
	// member offline.
	PresenceTimeout time.Duration
	// PresenceDone, when set, is told each finished presence sync (tests).
	PresenceDone func()
	// ServiceEnded, when set, is told the id of each service registration once it has ended (tests).
	ServiceEnded func(id string)
	// ClientClosing, when set, runs when the owner of a client session's close starts closing it, before it takes
	// the session's gate (tests).
	ClientClosing func()
	// ClientClosed, when set, runs when that owner has closed the session and its local connection, before it signals
	// the session closed (tests).
	ClientClosed func()
	// RegistrationEnding, when set, runs as a registration's single teardown starts (tests).
	RegistrationEnding func()
	// RegistrationJoining, when set, is told the id when a caller finds a registration's teardown already running,
	// just before it waits for it (tests).
	RegistrationJoining func(id string)
	// Registering, when set, runs after a registration became current and before its holder is answered (tests).
	Registering func()
	// HandshakeContext, when set, derives each incoming handshake's context; a test ends it to drive the handshake
	// deadline's path without waiting 10 s (tests).
	HandshakeContext func(context.Context) context.Context
	// HolderWriting, when set, runs as a holder queue's writer holds write ownership, before it writes (tests).
	HolderWriting func()
	// HolderFilling, when set, runs as a holder line becomes ready to write, on the goroutine that made it ready, before
	// the writer can reach it (tests).
	HolderFilling func()
	// ClientEnded, when set, runs when the goroutine that accepted a confirmed client or pairing session is done with
	// it, after everything that goroutine releases (tests).
	ClientEnded func()
	// ClientRegistering, when set, runs as a confirmed client or pairing session's check takes d.mu (tests).
	ClientRegistering func()
	// ClientConfirmed, when set, runs after a client or pairing handshake confirmed, before its session is
	// registered (tests).
	ClientConfirmed func()
	// ClientsWaiting, when set, is told how many handshakes of dropped keys an applied list waits for, before it
	// waits (tests).
	ClientsWaiting func(handshakes int)
	// PhoneSlots, when set, is told the node-wide count of held phone slots after every change, in order (tests).
	PhoneSlots func(total int)
}

// Daemon is one running node.
type Daemon struct {
	opt    Options
	st     *state.Store
	id     *ident.Identity
	nodeID string

	// leaving is set while a leave runs: a second one is refused instead of running beside it.
	leaving atomic.Bool

	cfgMu sync.Mutex
	// cfgSave and versionsSave hold one save of config.json or versions.json from snapshot to file.
	cfgSave, versionsSave sync.Mutex
	cfg                   state.Config

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
	// snapWatchers follow watch.snapshot; snapGen is the generation of the last published snapshot; snapRelays are
	// the relays it carries (guarded by d.mu, written under relaysMu).
	snapWatchers map[chan []byte]struct{}
	snapGen      uint64
	snapRelays   []SnapshotRelay
	relaysMu     sync.Mutex
	seen         map[string]seenInfo
	// versions is what each peer (by Noise key) announced in its last sync hello, kept in
	// versions.json so an offline member's last announcement still counts.
	versions map[string]string
	// acct are the running kind 0x04 sessions, oldest first.
	acct []*acctSlot
	// inviteWait holds the callers waiting on an invite's join.
	inviteWait map[string]chan joinOutcome
	// boundCreated, when set, runs after a bound invite is made and before its waiter is registered (tests).
	boundCreated func(id string)
	lastView     *mesh.View
	// saveErr is the last mesh save's error (nil once a save succeeds), shown by pen ls.
	saveErr error
	// hostKeysErr names the sshd key files the last host key check could not read, shown by pen ls.
	hostKeysErr string
	// traffic counts stream bytes per member and relay for the last 24 hours, in memory only (traffic.go).
	traffic *trafficWindow

	// svc holds the registered local services (services.go).
	svc serviceBook

	// controlSlots holds one token per open control connection (serveControl).
	controlSlots chan struct{}

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
	// client marks a session from a key that is not a member, admitted under reg (contract "Service clients"); k is
	// its key in d.sessions.
	client bool
	reg    *serviceReg
	k      uint64
	// inv is the burned invite of a pairing session (nil for a listed client); slot is its phone slot, returned by
	// the close owner.
	inv  *serviceInvite
	slot *phoneSlot
	// gate orders a client delivery's commit and identity line before its close; closing, closed and conn are
	// guarded by d.mu (clients.go).
	gate    sync.Mutex
	closing bool
	closed  chan struct{}
	conn    net.Conn
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
		opt.HostKeyGlob = defaultHostKeyGlob()
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
	if opt.PresenceTimeout == 0 {
		opt.PresenceTimeout = 15 * time.Second
	}
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.Awake == nil {
		opt.Awake = awakeClock()
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
		sessions: map[uint64]*live{}, watchers: map[chan []byte]struct{}{}, snapWatchers: map[chan []byte]struct{}{}, snapGen: 1,
		seen:     map[string]seenInfo{},
		versions: versions, inviteWait: map[string]chan joinOutcome{}, stopCh: make(chan struct{}),
	}
	d.svc.onPhones = opt.PhoneSlots
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
	d.traffic = newTrafficWindow(d.now)
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

// meshAndBook is the current store and invite book, read together so a mesh replacement cannot come between them.
func (d *Daemon) meshAndBook() (*mesh.Store, *mesh.Invites) {
	d.meshMu.RLock()
	defer d.meshMu.RUnlock()
	return d.store, d.invites
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
	// Uplinks first: startUplinks publishes the relay list before any control request, so no snapshot lacks it.
	d.startUplinks()
	d.spawn(func() { d.serveControl(ctx, ln) })
	d.spawn(func() { d.acceptLoop(ctx) })
	d.spawn(func() { d.every(ctx, d.opt.SyncEvery, func() { d.pushAll(ctx) }) })
	d.spawn(func() {
		d.every(ctx, logCapEvery, func() {
			d.capLog()
			d.pruneInvites()
			d.retrySave()
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
	release, err := state.TryLock(d.st.Path("daemon.lock"))
	if errors.Is(err, state.ErrLocked) {
		return nil, errors.New("a pen daemon is already running for this state directory")
	}
	return release, err
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
	d.relaysMu.Lock()
	defer d.relaysMu.Unlock()
	d.upMu.Lock()
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
				d.setUplinkState(sl, "replaced")
				d.writeDaemonJSON(d.now())
			}
		})
	}
	d.upMu.Unlock()
	d.publishRelaysLocked()
}

// setUplinkState sets one uplink's state and publishes the relays, in one step (contract "Snapshot watch").
func (d *Daemon) setUplinkState(sl *uplinkSlot, state string) {
	d.relaysMu.Lock()
	defer d.relaysMu.Unlock()
	sl.set(state)
	d.publishRelaysLocked()
}

// publishRelaysLocked publishes a snapshot when the configured relays or their uplink states differ from the last
// published ones. A slot that is no longer configured is not read, so its late callbacks never show. relaysMu is held;
// it orders every relay change with its publication (relaysMu, then upMu and uplinkSlot.mu, then d.mu).
func (d *Daemon) publishRelaysLocked() {
	d.upMu.Lock()
	states := make([]SnapshotRelay, 0, len(d.slots))
	for _, sl := range d.slots {
		states = append(states, SnapshotRelay{URL: sl.url, Uplink: sl.get()})
	}
	d.upMu.Unlock()
	d.mu.Lock()
	defer d.mu.Unlock()
	if slices.Equal(states, d.snapRelays) {
		return
	}
	d.snapRelays = states
	if d.lastView != nil {
		d.publishSnapshotLocked()
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
		d.setUplinkState(sl, "up")
		d.spawn(func() { d.pushAll(d.runCtx) })
	} else if sl.get() == "up" {
		d.setUplinkState(sl, "connecting")
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
	if s.Online != online {
		defer d.publishSnapshotLocked()
	}
	s.Online = online
	if online {
		s.At = d.now()
	}
	if via != "" {
		s.Relay = via
	}
	d.seen[m.SignPub] = s
}

// onMerged persists new records and publishes the new view; a failed save fails the sync that
// brought them, and pen ls shows it until a save succeeds.
func (d *Daemon) onMerged(added []*mesh.Record) error {
	err := d.saveMesh()
	d.viewChanged()
	if n := d.mesh().Len(); n >= mesh.MaxOrdinary {
		d.opt.Logf("mesh holds %d records: new members, names, locks and bindings are refused (revokes until %d); start a new mesh", n, mesh.MaxRecords)
	}
	return err
}

// saveMesh writes mesh.json and records the outcome for pen ls. While the set holds records it
// could not write, no sync is acknowledged and the daemon retries on each sync and every minute.
func (d *Daemon) saveMesh() error {
	err := d.mesh().Save()
	d.mu.Lock()
	was := d.saveErr
	d.saveErr = err
	d.mu.Unlock()
	if err != nil {
		d.opt.Logf("mesh save: %v; records received are not kept, so syncs are not acknowledged until a save succeeds", err)
	} else if was != nil {
		d.opt.Logf("mesh save: the state folder is writable again; every record is kept")
	}
	return err
}

// retrySave writes records that an earlier save could not.
func (d *Daemon) retrySave() {
	if d.mesh().Unsaved() {
		d.saveMesh()
	}
}

// viewChanged closes sessions of keys that are no longer members, tells watchers, rewrites known_hosts.
func (d *Daemon) viewChanged() {
	d.mu.Lock()
	// Read under d.mu, so a sweep always applies the newest view and a stale callback never sweeps an older one.
	v := d.view()
	if v == d.lastView {
		d.mu.Unlock()
		return
	}
	old := d.lastView
	d.lastView = v
	var doomed []*live
	// A client session closes only when the view makes its key a member or a revoked member.
	clients, _ := d.selectLocked(func(l *live) bool { return l.inv == nil && memberOrRevoked(v, l.remote) })
	for k, l := range d.sessions {
		if l.deferred || l.client {
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
	d.publishSnapshotLocked()
	d.mu.Unlock()
	for _, l := range doomed {
		l.sec.Close(4401)
	}
	for _, l := range clients {
		d.closeOwned(l, wire.CodeNotAdmitted)
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
		// One save at a time from snapshot to file, so an older snapshot never replaces a newer one.
		d.versionsSave.Lock()
		defer d.versionsSave.Unlock()
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
