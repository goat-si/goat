// Package logintest is an in-process login service (contract "Accounts") for hermetic tests: the
// device flow without Google (a test approves a code as the person would), assertions and the
// registry.
package logintest

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/login"
	"github.com/goat-si/goat/apps/pen/internal/strictjson"
)

// Device is a started device flow.
type Device struct {
	UserCode string
	Name     string
	SignPub  []byte
	NoisePub []byte
}

type device struct {
	Device
	code     string
	created  time.Time
	lastPoll time.Time
	state    string // pending, approved, denied, done
	acct     login.Account
}

type entry struct {
	meshID string
	nodes  map[string]login.OfferedMember
}

// Server is a fake login service.
type Server struct {
	URL string
	// MinPoll is the shortest gap between polls before slow_down (2 s); tests set 0.
	MinPoll time.Duration
	// AutoApprove, when set, approves every started device for this account at once.
	AutoApprove *login.Account
	clock       atomic.Pointer[func() time.Time]
	// ForgetStatus, when set, is the HTTP status every forget answers (503 as a service that is down,
	// 401 as one that refuses for clock skew).
	ForgetStatus atomic.Int32

	mu       sync.Mutex
	keys     []ed25519.PrivateKey
	devices  map[string]*device
	byUser   map[string]*device
	registry map[string]*entry
	used     map[string]bool
	names    map[string]string // assertion hash -> device name
	started  chan Device
	forgot   chan string
	attempts chan int
	http     *httptest.Server
}

// New builds an unstarted fake with a fresh login key.
func New() *Server {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	return &Server{MinPoll: 2 * time.Second, keys: []ed25519.PrivateKey{priv},
		devices: map[string]*device{}, byUser: map[string]*device{}, registry: map[string]*entry{},
		used: map[string]bool{}, names: map[string]string{}, started: make(chan Device, 64), forgot: make(chan string, 64),
		attempts: make(chan int, 64)}
}

// Start serves on 127.0.0.1 and sets URL.
func (s *Server) Start() {
	s.http = httptest.NewServer(s)
	s.URL = s.http.URL
}

// Close stops serving.
func (s *Server) Close() {
	if s.http != nil {
		s.http.Close()
	}
}

// Started delivers each device flow as it starts.
func (s *Server) Started() <-chan Device { return s.started }

// Forgotten delivers the nodeId of each node a forget removed.
func (s *Server) Forgotten() <-chan string { return s.forgot }

// ForgetAttempts delivers the HTTP status of each forget request.
func (s *Server) ForgetAttempts() <-chan int { return s.attempts }

// Key is the current login key.
func (s *Server) Key() login.Key {
	s.mu.Lock()
	defer s.mu.Unlock()
	return keyOf(s.keys[len(s.keys)-1])
}

// Signer is the current login key's private half (tests mint assertions with it).
func (s *Server) Signer() ed25519.PrivateKey {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.keys[len(s.keys)-1]
}

// Rotate adds a new current key; the old ones stay listed.
func (s *Server) Rotate() login.Key {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	s.mu.Lock()
	s.keys = append(s.keys, priv)
	s.mu.Unlock()
	return keyOf(priv)
}

func keyOf(priv ed25519.PrivateKey) login.Key {
	pub := priv.Public().(ed25519.PublicKey)
	return login.Key{Kid: login.Kid(pub), Pub: ident.B64.EncodeToString(pub)}
}

// Approve finishes the sign-in for userCode as acct (the person typed the code and confirmed).
func (s *Server) Approve(userCode string, acct login.Account) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.byUser[userCode]
	if d == nil || d.state != "pending" {
		return false
	}
	d.state, d.acct = "approved", acct
	return true
}

// Deny ends the sign-in for userCode as denied.
func (s *Server) Deny(userCode string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.byUser[userCode]
	if d == nil || d.state != "pending" {
		return false
	}
	d.state = "denied"
	return true
}

// Reset removes the account's mesh and nodes (the verification site's reset).
func (s *Server) Reset(sub string) {
	s.mu.Lock()
	delete(s.registry, sub)
	s.mu.Unlock()
}

// Registry is the account's mesh id and nodes.
func (s *Server) Registry(sub string) (string, []login.OfferedMember) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.registry[sub]
	if e == nil {
		return "", nil
	}
	return e.meshID, offered(e)
}

func offered(e *entry) []login.OfferedMember {
	out := make([]login.OfferedMember, 0, len(e.nodes))
	for _, m := range e.nodes {
		out = append(out, m)
	}
	return out
}

// Issue mints an assertion with the current key (tests use it for forged or skewed cases).
func (s *Server) Issue(sub, email string, signPub, noisePub []byte, at time.Time) *login.Assertion {
	a, _ := login.Issue(s.Signer(), s.URL, sub, email, signPub, noisePub, at)
	return a
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && r.URL.Path == "/v1/keys" {
		s.mu.Lock()
		keys := make([]login.Key, 0, len(s.keys))
		for _, k := range s.keys {
			keys = append(keys, keyOf(k))
		}
		s.mu.Unlock()
		reply(w, http.StatusOK, map[string]any{"keys": keys})
		return
	}
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	body := http.MaxBytesReader(w, r.Body, 16<<10)
	switch r.URL.Path {
	case "/v1/device/start":
		s.start(w, body)
	case "/v1/device/token":
		s.token(w, body)
	case "/v1/mesh/register":
		s.register(w, body)
	case "/v1/mesh/forget":
		if code := int(s.ForgetStatus.Load()); code != 0 {
			s.attempt(code)
			reply(w, code, map[string]string{"error": http.StatusText(code)})
			return
		}
		s.forget(w, body)
	default:
		http.NotFound(w, r)
	}
}

func reply(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func decode(r interface{ Read([]byte) (int, error) }, v any) bool {
	var raw json.RawMessage
	if json.NewDecoder(r).Decode(&raw) != nil {
		return false
	}
	return strictjson.Unmarshal(raw, v) == nil
}

func randCode(n int) string {
	const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ" // Crockford base32
	b := make([]byte, n)
	rand.Read(b)
	for i := range b {
		b[i] = alphabet[int(b[i])%32]
	}
	return string(b)
}

func (s *Server) start(w http.ResponseWriter, r interface{ Read([]byte) (int, error) }) {
	var in struct {
		SignPub  string `json:"signPub"`
		NoisePub string `json:"noisePub"`
		Name     string `json:"name"`
		Proof    string `json:"proof"`
	}
	if !decode(r, &in) {
		reply(w, http.StatusBadRequest, map[string]string{"error": "bad request"})
		return
	}
	sp, err1 := ident.DecodeKey(in.SignPub)
	np, err2 := ident.DecodeKey(in.NoisePub)
	proof, err3 := ident.B64.DecodeString(in.Proof)
	if err1 != nil || err2 != nil || err3 != nil || !ident.ValidName(in.Name) ||
		!ed25519.Verify(sp, login.StartMessage(sp, np, in.Name), proof) {
		reply(w, http.StatusBadRequest, map[string]string{"error": "bad proof"})
		return
	}
	raw := make([]byte, 32)
	rand.Read(raw)
	user := randCode(8)
	d := &device{Device: Device{UserCode: user[:4] + "-" + user[4:], Name: in.Name, SignPub: sp, NoisePub: np},
		code: ident.B64.EncodeToString(raw), created: s.now(), state: "pending"}
	s.mu.Lock()
	s.devices[d.code] = d
	s.byUser[d.UserCode] = d
	if s.AutoApprove != nil {
		d.state, d.acct = "approved", *s.AutoApprove
	}
	s.mu.Unlock()
	select {
	case s.started <- d.Device:
	default:
	}
	reply(w, http.StatusOK, login.Start{DeviceCode: d.code, UserCode: d.UserCode, VerificationURI: s.URL + "/device", Interval: 2, ExpiresIn: 600})
}

func (s *Server) token(w http.ResponseWriter, r interface{ Read([]byte) (int, error) }) {
	var in struct {
		DeviceCode string `json:"deviceCode"`
		Proof      string `json:"proof"`
	}
	if !decode(r, &in) {
		reply(w, http.StatusBadRequest, map[string]string{"error": "bad request"})
		return
	}
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.devices[in.DeviceCode]
	proof, _ := ident.B64.DecodeString(in.Proof)
	if d == nil || !ed25519.Verify(d.SignPub, login.PollMessage(in.DeviceCode), proof) {
		reply(w, http.StatusBadRequest, map[string]string{"error": "bad proof"})
		return
	}
	if !d.lastPoll.IsZero() && now.Sub(d.lastPoll) < s.MinPoll {
		d.lastPoll = now
		reply(w, http.StatusTooManyRequests, map[string]string{"status": "slow_down"})
		return
	}
	d.lastPoll = now
	if now.Sub(d.created) >= 600*time.Second || d.state == "done" {
		reply(w, http.StatusGone, map[string]string{"status": "expired"})
		return
	}
	switch d.state {
	case "pending":
		reply(w, http.StatusPreconditionRequired, map[string]string{"status": "pending"})
		return
	case "denied":
		reply(w, http.StatusForbidden, map[string]string{"status": "denied"})
		return
	}
	d.state = "done"
	priv := s.keys[len(s.keys)-1]
	a, err := login.Issue(priv, s.URL, d.acct.Sub, d.acct.Email, d.SignPub, d.NoisePub, now)
	if err != nil {
		reply(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	s.names[a.Hash()] = d.Name
	var m *login.OfferedMesh
	if e := s.registry[d.acct.Sub]; e != nil {
		m = &login.OfferedMesh{MeshID: e.meshID, Members: offered(e)}
	}
	reply(w, http.StatusOK, login.Token{Assertion: a, Account: d.acct, LoginKey: keyOf(priv), Mesh: m})
}

func (s *Server) register(w http.ResponseWriter, r interface{ Read([]byte) (int, error) }) {
	var in struct {
		Assertion *login.Assertion `json:"assertion"`
		MeshID    string           `json:"meshId"`
		Proof     string           `json:"proof"`
	}
	if !decode(r, &in) || in.Assertion == nil || in.MeshID == "" {
		reply(w, http.StatusBadRequest, map[string]string{"error": "bad request"})
		return
	}
	signPub, err1 := ident.DecodeKey(in.Assertion.A.SignPub)
	proof, err2 := ident.B64.DecodeString(in.Proof)
	if err1 != nil || err2 != nil || !ed25519.Verify(signPub, login.RegisterMessage(in.Assertion.Body, in.MeshID), proof) {
		reply(w, http.StatusBadRequest, map[string]string{"error": "bad_proof"})
		return
	}
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	a := in.Assertion
	ok := false
	for _, k := range s.keys {
		if a.Verify(keyOf(k)) == nil {
			ok = true
		}
	}
	if !ok || a.A.Iss != s.URL {
		reply(w, http.StatusBadRequest, map[string]string{"error": "bad_signature"})
		return
	}
	if !now.Before(time.Unix(a.A.Exp, 0)) {
		reply(w, http.StatusBadRequest, map[string]string{"error": "expired"})
		return
	}
	if s.used[a.Hash()] {
		reply(w, http.StatusConflict, map[string]string{"error": "assertion_used"})
		return
	}
	e := s.registry[a.A.Sub]
	if e == nil {
		e = &entry{meshID: in.MeshID, nodes: map[string]login.OfferedMember{}}
		s.registry[a.A.Sub] = e
	} else if e.meshID != in.MeshID {
		reply(w, http.StatusConflict, map[string]any{"error": "mesh_mismatch", "meshId": e.meshID})
		return
	}
	s.used[a.Hash()] = true
	sp, _ := ident.DecodeKey(a.A.SignPub)
	nodeID := ident.NodeID(sp)
	e.nodes[nodeID] = login.OfferedMember{NodeID: nodeID, SignPub: a.A.SignPub, NoisePub: a.A.NoisePub, Name: s.names[a.Hash()]}
	reply(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) forget(w http.ResponseWriter, r interface{ Read([]byte) (int, error) }) {
	var in struct {
		NodeID string `json:"nodeId"`
		By     string `json:"by"`
		TS     uint64 `json:"ts"`
		Proof  string `json:"proof"`
	}
	if !decode(r, &in) {
		reply(w, http.StatusBadRequest, map[string]string{"error": "bad request"})
		return
	}
	by, err1 := ident.DecodeKey(in.By)
	proof, err2 := ident.B64.DecodeString(in.Proof)
	now := s.now()
	skew := now.Sub(time.UnixMilli(int64(in.TS)))
	if err1 != nil || err2 != nil || skew > login.ForgetWindow || skew < -login.ForgetWindow ||
		!ed25519.Verify(by, login.ForgetMessage(in.NodeID, in.TS), proof) {
		reply(w, http.StatusBadRequest, map[string]string{"error": "bad proof or stale ts"})
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	byID := ident.NodeID(by)
	for _, e := range s.registry {
		if _, ok := e.nodes[in.NodeID]; !ok {
			continue
		}
		if _, ok := e.nodes[byID]; !ok && byID != in.NodeID {
			reply(w, http.StatusForbidden, map[string]string{"error": "signer is not under this account"})
			return
		}
		delete(e.nodes, in.NodeID)
		select {
		case s.forgot <- in.NodeID:
		default:
		}
	}
	reply(w, http.StatusOK, map[string]bool{"ok": true})
}

// SplitAccount parses "sub,email" (the command's --approve flag).
func SplitAccount(s string) (login.Account, bool) {
	sub, email, ok := strings.Cut(s, ",")
	return login.Account{Sub: sub, Email: email}, ok && sub != ""
}

func (s *Server) attempt(code int) {
	select {
	case s.attempts <- code:
	default:
	}
}

// SetNow replaces the service's clock (time.Now by default).
func (s *Server) SetNow(f func() time.Time) { s.clock.Store(&f) }

func (s *Server) now() time.Time {
	if f := s.clock.Load(); f != nil {
		return (*f)()
	}
	return time.Now()
}
