package daemon

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/json"
	"errors"
	"html"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/strictjson"
)

//go:embed dashboard/index.html dashboard/app.js dashboard/style.css
var dashboardFiles embed.FS

const (
	// DashboardFile is the redirect page pen dashboard opens; it holds the one-time token, so it
	// goes as soon as the token is used, expires, or the dashboard stops.
	DashboardFile = "dashboard.html"
	// DashboardTokenTTL is how long a one-time token stays valid.
	DashboardTokenTTL = 10 * time.Minute

	dashMaxBody     = 16 << 10
	dashMaxConns    = 16
	dashMaxSessions = 16
	dashMaxEvents   = 50
	dashMinInvite   = time.Minute
	dashMaxInvite   = 24 * time.Hour
)

// dashIdleTimeout closes a kept-alive connection that sends nothing, freeing its slot of dashMaxConns.
var dashIdleTimeout = 5 * time.Second

// DashboardReply answers op "dashboard".
type DashboardReply struct {
	// URL carries the one-time token in its fragment, which never reaches a server or a log.
	URL       string `json:"url"`
	File      string `json:"file"`
	ExpiresAt int64  `json:"expiresAt"`
}

// dashboard is the local management page: 127.0.0.1 only, one-time token, bearer sessions.
type dashboard struct {
	d    *Daemon
	srv  *http.Server
	port string
	// key derives each session's server id, which the page checks on every response; it never
	// leaves the daemon, so a program on the port after the dashboard stops cannot forge the id.
	key []byte

	mu       sync.Mutex
	token    [32]byte // sha256 of the outstanding one-time token
	hasToken bool
	tokenExp time.Time
	expiry   *time.Timer
	// sessions are bearer hashes with their creation order; the oldest goes past dashMaxSessions.
	sessions map[[32]byte]uint64
	nextSess uint64
}

// openDashboard starts the dashboard once and mints a fresh one-time token (op "dashboard").
func (d *Daemon) openDashboard() (DashboardReply, error) {
	d.dashMu.Lock()
	defer d.dashMu.Unlock()
	if d.dashClosed {
		return DashboardReply{}, errors.New("the daemon is stopping")
	}
	if d.dash == nil {
		ds, err := d.startDashboard()
		if err != nil {
			return DashboardReply{}, err
		}
		d.dash = ds
	}
	return d.dash.mint()
}

// stopDashboard closes the server and every session (op "dashboard-stop", and the daemon's end).
func (d *Daemon) stopDashboard(closing bool) bool {
	d.dashMu.Lock()
	defer d.dashMu.Unlock()
	if closing {
		d.dashClosed = true
	}
	ds := d.dash
	d.dash = nil
	if ds == nil {
		os.Remove(d.st.Path(DashboardFile))
		return false
	}
	ds.close()
	return true
}

func (d *Daemon) startDashboard() (*dashboard, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	key := make([]byte, 32)
	rand.Read(key)
	ds := &dashboard{d: d, port: strconv.Itoa(ln.Addr().(*net.TCPAddr).Port), key: key, sessions: map[[32]byte]uint64{}}
	ds.srv = &http.Server{
		Handler:           ds.routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		// Approve, revoke and lock push to every member (30 s each, concurrently).
		WriteTimeout:   90 * time.Second,
		IdleTimeout:    dashIdleTimeout,
		MaxHeaderBytes: 16 << 10,
		ErrorLog:       log.New(io.Discard, "", 0),
	}
	srv := ds.srv
	l := &capListener{Listener: ln, sem: make(chan struct{}, dashMaxConns)}
	d.spawn(func() { srv.Serve(l) })
	return ds, nil
}

// redirectPage opens the dashboard; URL is replaced by the escaped fragment URL.
const redirectPage = `<!doctype html>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="0; url=URL">
<title>pen dashboard</title>
<p><a href="URL">pen dashboard 열기 · open the pen dashboard</a></p>
`

func (ds *dashboard) origin() string { return "http://127.0.0.1:" + ds.port }

func randomB64() string {
	b := make([]byte, 32)
	rand.Read(b)
	return ident.B64.EncodeToString(b)
}

// mint replaces the outstanding token and rewrites the redirect file that opens the page with it.
func (ds *dashboard) mint() (DashboardReply, error) {
	tok := randomB64()
	u := ds.origin() + "/#t=" + tok
	page := strings.ReplaceAll(redirectPage, "URL", html.EscapeString(u))
	ds.mu.Lock()
	defer ds.mu.Unlock()
	if err := ds.d.st.WriteAtomic(DashboardFile, []byte(page), 0o600); err != nil {
		return DashboardReply{}, err
	}
	ds.token, ds.hasToken = sha256.Sum256([]byte(tok)), true
	ds.tokenExp = ds.d.now().Add(DashboardTokenTTL)
	if ds.expiry != nil {
		ds.expiry.Stop()
	}
	h := ds.token
	ds.expiry = time.AfterFunc(DashboardTokenTTL, func() { ds.expire(h) })
	return DashboardReply{URL: u, File: ds.d.st.Path(DashboardFile), ExpiresAt: ds.tokenExp.UnixMilli()}, nil
}

func (ds *dashboard) expire(h [32]byte) {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	if ds.hasToken && ds.token == h {
		ds.dropTokenLocked()
	}
}

func (ds *dashboard) dropTokenLocked() {
	ds.hasToken = false
	if ds.expiry != nil {
		ds.expiry.Stop()
	}
	os.Remove(ds.d.st.Path(DashboardFile))
}

// exchange trades the one-time token for a bearer secret, once.
func (ds *dashboard) exchange(tok string) (string, bool) {
	h := sha256.Sum256([]byte(tok))
	ds.mu.Lock()
	defer ds.mu.Unlock()
	if !ds.hasToken || subtle.ConstantTimeCompare(h[:], ds.token[:]) != 1 {
		return "", false
	}
	ds.dropTokenLocked()
	if !ds.d.now().Before(ds.tokenExp) {
		return "", false
	}
	bearer := randomB64()
	if len(ds.sessions) >= dashMaxSessions {
		var oldest [32]byte
		first := true
		for k, n := range ds.sessions {
			if first || n < ds.sessions[oldest] {
				oldest, first = k, false
			}
		}
		delete(ds.sessions, oldest)
	}
	ds.nextSess++
	ds.sessions[sha256.Sum256([]byte(bearer))] = ds.nextSess
	return bearer, true
}

// serverID is HMAC-SHA256(key, bearer): the id /api/session hands the page with its bearer.
func (ds *dashboard) serverID(bearer string) string {
	m := hmac.New(sha256.New, ds.key)
	m.Write([]byte(bearer))
	return ident.B64.EncodeToString(m.Sum(nil))
}

// bearerOf is the Authorization bearer; cookies never authenticate.
func bearerOf(r *http.Request) (string, bool) {
	b, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return b, ok && b != ""
}

func (ds *dashboard) authorized(r *http.Request) bool {
	b, ok := bearerOf(r)
	if !ok {
		return false
	}
	h := sha256.Sum256([]byte(b))
	ds.mu.Lock()
	defer ds.mu.Unlock()
	_, ok = ds.sessions[h]
	return ok
}

func (ds *dashboard) logout(r *http.Request) {
	if b, ok := bearerOf(r); ok {
		ds.mu.Lock()
		delete(ds.sessions, sha256.Sum256([]byte(b)))
		ds.mu.Unlock()
	}
}

func (ds *dashboard) close() {
	ds.srv.Close()
	ds.mu.Lock()
	defer ds.mu.Unlock()
	clear(ds.sessions)
	ds.dropTokenLocked()
}

func (ds *dashboard) routes() http.Handler {
	mux := http.NewServeMux()
	for _, f := range []struct{ path, file, typ string }{
		{"GET /{$}", "index.html", "text/html; charset=utf-8"},
		{"GET /app.js", "app.js", "text/javascript; charset=utf-8"},
		{"GET /style.css", "style.css", "text/css; charset=utf-8"},
	} {
		body, err := dashboardFiles.ReadFile("dashboard/" + f.file)
		if err != nil {
			panic(err) // embedded at build time
		}
		mux.HandleFunc(f.path, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", f.typ)
			w.Write(body)
		})
	}
	mux.HandleFunc("POST /api/session", ds.handleSession)
	mux.HandleFunc("GET /api/state", ds.authed(ds.handleState))
	mux.HandleFunc("POST /api/logout", ds.authed(func(w http.ResponseWriter, r *http.Request) {
		ds.logout(r)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("POST /api/approve", ds.authed(ds.handleApprove))
	mux.HandleFunc("POST /api/deny", ds.authed(ds.handleDeny))
	mux.HandleFunc("POST /api/revoke", ds.authed(ds.handleRevoke))
	mux.HandleFunc("POST /api/lock", ds.authed(ds.handleLock))
	mux.HandleFunc("POST /api/relays", ds.authed(ds.handleRelays))
	mux.HandleFunc("POST /api/invite", ds.authed(ds.handleInvite))
	return ds.guard(mux)
}

// guard applies to every request: headers, the Host check (DNS rebinding), and for anything but
// GET the Origin check and the body cap. No CORS headers are ever sent.
func (ds *dashboard) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		// Every answer to a request carrying a bearer, refusals included, names that session's
		// server id; a caller without the bearer never sees it.
		if b, ok := bearerOf(r); ok {
			h.Set("X-Pen-Server", ds.serverID(b))
		}
		h.Set("Cache-Control", "no-store")
		h.Set("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		if r.Host != "127.0.0.1:"+ds.port && r.Host != "localhost:"+ds.port {
			jsonError(w, http.StatusForbidden, "this address does not serve the pen dashboard")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if r.Header.Get("Origin") != "http://"+r.Host {
				jsonError(w, http.StatusForbidden, "cross-origin request refused")
				return
			}
		}
		r.Body = http.MaxBytesReader(w, r.Body, dashMaxBody)
		next.ServeHTTP(w, r)
	})
}

func (ds *dashboard) authed(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !ds.authorized(r) {
			jsonError(w, http.StatusUnauthorized, "no session; run pen dashboard")
			return
		}
		h(w, r)
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func jsonError(w http.ResponseWriter, code int, msg string) {
	// A refused request gives its connection back: kept open, 16 of them would lock the page out.
	w.Header().Set("Connection", "close")
	writeJSON(w, code, map[string]string{"error": msg})
}

// decodeBody reads a JSON body with exactly v's member names.
func decodeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	if mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); mt != "application/json" {
		jsonError(w, http.StatusUnsupportedMediaType, "send application/json")
		return false
	}
	b, err := io.ReadAll(r.Body)
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		jsonError(w, http.StatusRequestEntityTooLarge, "request body over 16 KiB")
		return false
	}
	if err != nil {
		jsonError(w, http.StatusBadRequest, "unreadable request body")
		return false
	}
	if err := strictjson.Unmarshal(b, v); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request: "+err.Error())
		return false
	}
	return true
}

// run calls the same daemon op the CLI sends and answers its result, or 409 with the daemon's error.
func (ds *dashboard) run(w http.ResponseWriter, req Request, wrap func(any) any) {
	res, err := ds.d.do(ds.d.runCtx, req)
	if err != nil {
		jsonError(w, http.StatusConflict, err.Error())
		return
	}
	if wrap != nil {
		res = wrap(res)
	}
	writeJSON(w, http.StatusOK, res)
}

func (ds *dashboard) handleSession(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token string `json:"token"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	bearer, ok := ds.exchange(in.Token)
	if !ok {
		jsonError(w, http.StatusUnauthorized, "this link was already used or has expired; run pen dashboard for a new one")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"bearer": bearer, "server": ds.serverID(bearer)})
}

func isHex(s string) bool {
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

func (ds *dashboard) handleApprove(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Fingerprint string `json:"fingerprint"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	if fp := NormalizeFingerprint(in.Fingerprint); len(fp) != 40 || !isHex(fp) {
		jsonError(w, http.StatusBadRequest, "paste the whole fingerprint (10 groups of 4) as the new machine's terminal shows it; the request id is not enough here")
		return
	}
	ds.run(w, Request{Op: "approve", Subject: in.Fingerprint}, nil)
}

func (ds *dashboard) handleDeny(w http.ResponseWriter, r *http.Request) {
	var in struct {
		// Fingerprint is the request id or the full fingerprint, as pen deny takes.
		Fingerprint string `json:"fingerprint"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	ds.run(w, Request{Op: "deny", Subject: in.Fingerprint}, nil)
}

func (ds *dashboard) handleRevoke(w http.ResponseWriter, r *http.Request) {
	var in struct {
		NodeID      string `json:"nodeId"`
		Compromised bool   `json:"compromised"`
		ConfirmName string `json:"confirmName"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	v := ds.d.view()
	m, ok := v.MemberByNodeID(in.NodeID)
	if !ok && in.Compromised {
		m, ok = v.RevokedByNodeID(in.NodeID)
	}
	if !ok {
		jsonError(w, http.StatusConflict, "not a current member")
		return
	}
	if in.ConfirmName != m.Name {
		jsonError(w, http.StatusBadRequest, "type the member's name exactly to confirm")
		return
	}
	ds.run(w, Request{Op: "revoke", Subject: m.SignPub, Compromised: in.Compromised}, func(res any) any {
		out := map[string]any{"results": res.(map[string]any)["results"]}
		if in.Compromised {
			out["next"] = CompromisedNextSteps(m.Name, v.Account)
		}
		return out
	})
}

func (ds *dashboard) handleLock(w http.ResponseWriter, r *http.Request) {
	var in struct {
		On *bool `json:"on"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	if in.On == nil {
		jsonError(w, http.StatusBadRequest, "say on true or false")
		return
	}
	ds.run(w, Request{Op: "lock", On: *in.On}, nil)
}

func (ds *dashboard) handleRelays(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Relays []string `json:"relays"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	ds.run(w, Request{Op: "relays", Relays: in.Relays}, nil)
}

func (ds *dashboard) handleInvite(w http.ResponseWriter, r *http.Request) {
	var in struct {
		TTLMs int64 `json:"ttlMs"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	if ttl := time.Duration(in.TTLMs) * time.Millisecond; in.TTLMs != 0 && (ttl < dashMinInvite || ttl > dashMaxInvite) {
		jsonError(w, http.StatusBadRequest, "an invite lasts 1 minute to 24 hours")
		return
	}
	ds.run(w, Request{Op: "invite", TTLMs: in.TTLMs}, nil)
}

// DashAccount is the mesh's Google binding as the page shows it.
type DashAccount struct {
	LoginURL string `json:"loginUrl"`
	Sub      string `json:"sub"`
	// Email is known from this node's own sign-in or a member admitted via Google ("" otherwise).
	Email string `json:"email,omitempty"`
}

// DashPending is a queued request without its full fingerprint: the person reads that on the new
// machine and pastes it, so the page must not offer it.
type DashPending struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	NodeID string `json:"nodeId"`
	Email  string `json:"email"`
	At     int64  `json:"at"`
}

// DashEvent is one effective signed record.
type DashEvent struct {
	At int64 `json:"at"`
	// Kind is found, admit, revoke, leave, name, account or lock.
	Kind        string   `json:"kind"`
	Who         []string `json:"who,omitempty"`
	By          string   `json:"by"`
	Via         string   `json:"via,omitempty"`
	Email       string   `json:"email,omitempty"`
	Compromised bool     `json:"compromised,omitempty"`
	// On is a lock's state, or for an account record whether it binds (false unbinds).
	On *bool `json:"on,omitempty"`
}

// DashState is GET /api/state.
type DashState struct {
	Self          Status        `json:"self"`
	Uplink        string        `json:"uplink"`
	Members       []LsMember    `json:"members"`
	Account       *DashAccount  `json:"account"`
	Locked        bool          `json:"locked"`
	Relays        []RelayState  `json:"relays"`
	Pending       []DashPending `json:"pending"`
	Events        []DashEvent   `json:"events"`
	DownloadRelay string        `json:"downloadRelay"`
	LoginCommand  string        `json:"loginCommand"`
	// LoginCommandWindows is LoginCommand for PowerShell.
	LoginCommandWindows string `json:"loginCommandWindows"`
	// Unforgotten are revoked machines the login service still offers (see LsReply).
	Unforgotten []Unforgotten `json:"unforgotten"`
	// SaveError and Full show what pen ls shows: the mesh cannot be saved, or holds its cap of
	// ordinary records.
	SaveError string `json:"saveError,omitempty"`
	Full      bool   `json:"full"`
	// ApproveQuestion is the warning pen approve asks before approving by request id.
	ApproveQuestion string `json:"approveQuestion"`
	Now             int64  `json:"now"`
	// Relays24h and TrafficSince are pen ls's (each member's own totals are in Members); Revoked24h sums the bytes of
	// revoked members, which the page does not list.
	Relays24h    []RelayTraffic `json:"relays24h"`
	TrafficSince int64          `json:"trafficSince,omitempty"`
	Revoked24h   *MemberTraffic `json:"revoked24h,omitempty"`
}

func (ds *dashboard) handleState(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, ds.d.dashState())
}

func (d *Daemon) dashState() DashState {
	d.refreshPresence()
	ls := d.ls()
	v := d.view()
	s := DashState{Self: d.status(), Uplink: ls.Uplink, Members: ls.Members, Locked: v.Locked, Relays: d.relayStates(),
		Pending: []DashPending{}, Events: d.events(v), DownloadRelay: d.downloadRelay(), ApproveQuestion: ApproveQuestion,
		Now: d.now().UnixMilli(), Unforgotten: ls.Unforgotten, SaveError: ls.SaveError, Full: ls.Records >= mesh.MaxOrdinary,
		Relays24h: ls.Relays24h, TrafficSince: ls.TrafficSince}
	if s.Relays24h == nil {
		s.Relays24h = []RelayTraffic{}
	}
	for _, r := range ls.Revoked {
		if t := r.Traffic24h; t != nil {
			if s.Revoked24h == nil {
				s.Revoked24h = &MemberTraffic{Relays: []RelayTraffic{}}
			}
			s.Revoked24h.add(t.In, t.Out)
		}
	}
	if s.Unforgotten == nil {
		s.Unforgotten = []Unforgotten{}
	}
	if s.Members == nil {
		s.Members = []LsMember{}
	}
	s.LoginCommand = LoginCommand(s.DownloadRelay)
	s.LoginCommandWindows = LoginCommandWindows(s.DownloadRelay)
	if v.Account != nil {
		s.Account = &DashAccount{LoginURL: v.Account.LoginURL, Sub: v.Account.Sub, Email: d.accountEmail(v)}
	}
	for _, p := range d.pending.all(d.now()) {
		s.Pending = append(s.Pending, DashPending{ID: p.ID, Name: p.Name, NodeID: p.NodeID, Email: p.Email, At: p.At})
	}
	return s
}

// accountEmail names the bound account from login.json (written by pen login here) or from a
// member admitted via Google.
func (d *Daemon) accountEmail(v *mesh.View) string {
	var l struct {
		Sub   string `json:"sub"`
		Email string `json:"email"`
	}
	if ok, _ := d.st.ReadJSON("login.json", &l); ok && l.Sub == v.Account.Sub && l.Email != "" {
		return l.Email
	}
	for _, m := range v.SortedMembers() {
		if m.Via == mesh.ViaGoogle && m.Email != "" {
			return m.Email
		}
	}
	return ""
}

// events lists the newest effective records (hostkeys records left out).
func (d *Daemon) events(v *mesh.View) []DashEvent {
	names := map[string]string{}
	for k, m := range v.Revoked {
		names[k] = m.Name
	}
	for k, m := range v.Members {
		names[k] = m.Name
	}
	name := func(k string) string {
		if n := names[k]; n != "" {
			return n
		}
		if pub, err := ident.DecodeKey(k); err == nil {
			return ident.NodeID(pub)[:8]
		}
		return "?"
	}
	out := []DashEvent{}
	for _, r := range d.mesh().Records() {
		if !v.Effective[r.Hash] {
			continue
		}
		b := &r.B
		e := DashEvent{At: b.At, By: name(b.By)}
		switch b.Type {
		case mesh.TypeFound:
			e.Kind, e.Who = "found", []string{b.Card.C.Name}
		case mesh.TypeAdmit:
			e.Kind, e.Who, e.Via = "admit", []string{b.Card.C.Name}, "invite"
			if b.Via != nil {
				e.Via = *b.Via
			}
			if b.Email != nil {
				e.Email = *b.Email
			}
		case mesh.TypeRevoke:
			e.Kind = "revoke"
			if len(b.Subjects) == 1 && b.Subjects[0] == b.By {
				e.Kind = "leave"
			}
			for _, s := range b.Subjects {
				e.Who = append(e.Who, name(s))
			}
			e.Compromised = b.Compromised != nil && *b.Compromised
		case mesh.TypeName:
			e.Kind, e.Who = "name", []string{b.Name}
		case mesh.TypeAccount:
			on := b.LoginURL != nil
			e.Kind, e.On = "account", &on
		case mesh.TypeLock:
			on := b.On != nil && *b.On
			e.Kind, e.On = "lock", &on
		default:
			continue
		}
		out = append(out, e)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At > out[j].At })
	if len(out) > dashMaxEvents {
		out = out[:dashMaxEvents]
	}
	return out
}

// capListener refuses connections past its cap instead of queueing them.
type capListener struct {
	net.Listener
	sem chan struct{}
}

func (l *capListener) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		select {
		case l.sem <- struct{}{}:
			return &capConn{Conn: c, sem: l.sem}, nil
		default:
			c.Close()
		}
	}
}

type capConn struct {
	net.Conn
	once sync.Once
	sem  chan struct{}
}

func (c *capConn) Close() error {
	// The slot frees before the socket closes, so a peer that sees the close can count on it.
	c.once.Do(func() { <-c.sem })
	return c.Conn.Close()
}
