package daemon

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

// dash is one dashboard as a browser on this machine reaches it.
type dash struct {
	t    *testing.T
	n    *node
	base string
	c    *http.Client
}

// openDash runs op "dashboard" and returns the page origin and the one-time token.
func openDash(t *testing.T, n *node) (*dash, string) {
	t.Helper()
	var r DashboardReply
	if err := Call(n.st, Request{Op: "dashboard"}, &r); err != nil {
		t.Fatal(err)
	}
	base, tok, ok := strings.Cut(r.URL, "/#t=")
	if !ok || !strings.HasPrefix(base, "http://127.0.0.1:") || tok == "" {
		t.Fatalf("dashboard url %q", r.URL)
	}
	return &dash{t: t, n: n, base: base, c: &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}}, tok
}

type reply struct {
	code int
	hdr  http.Header
	body []byte
}

func (r reply) json(t *testing.T, v any) {
	t.Helper()
	if err := json.Unmarshal(r.body, v); err != nil {
		t.Fatalf("%d %s: %v", r.code, r.body, err)
	}
}

// send makes a request; set may change it (Host, Origin, headers) before it goes.
func (d *dash) send(method, path, bearer string, body any, set func(*http.Request)) reply {
	d.t.Helper()
	var rd io.Reader
	if body != nil {
		if b, ok := body.([]byte); ok {
			rd = bytes.NewReader(b)
		} else {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
	}
	req, err := http.NewRequest(method, d.base+path, rd)
	if err != nil {
		d.t.Fatal(err)
	}
	if method != http.MethodGet {
		req.Header.Set("Origin", d.base)
		req.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	if set != nil {
		set(req)
	}
	res, err := d.c.Do(req)
	if err != nil {
		d.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return reply{res.StatusCode, res.Header, b}
}

func (d *dash) get(path, bearer string) reply { return d.send(http.MethodGet, path, bearer, nil, nil) }

func (d *dash) post(path, bearer string, body any) reply {
	return d.send(http.MethodPost, path, bearer, body, nil)
}

// login exchanges tok for a bearer and fails the test otherwise.
func (d *dash) login(tok string) string {
	d.t.Helper()
	r := d.post("/api/session", "", map[string]string{"token": tok})
	var out struct{ Bearer string }
	r.json(d.t, &out)
	if r.code != http.StatusOK || out.Bearer == "" {
		d.t.Fatalf("session: %d %s", r.code, r.body)
	}
	return out.Bearer
}

func (d *dash) state(bearer string) DashState {
	d.t.Helper()
	r := d.get("/api/state", bearer)
	if r.code != http.StatusOK {
		d.t.Fatalf("state: %d %s", r.code, r.body)
	}
	var s DashState
	r.json(d.t, &s)
	return s
}

func want(t *testing.T, what string, r reply, code int) {
	t.Helper()
	if r.code != code {
		t.Fatalf("%s: %d %s, want %d", what, r.code, r.body, code)
	}
}

func fileGone(t *testing.T, n *node) bool {
	t.Helper()
	_, err := os.Stat(n.st.Path(DashboardFile))
	return errors.Is(err, os.ErrNotExist)
}

func TestDashboardFragmentTokenExchangesForABearerOnce(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	clk := &clock{}
	clk.ms.Store(time.Now().UnixMilli())
	a := founder(t, ctx, rs, "a", clk)
	d, tok := openDash(t, a)
	fi, err := os.Stat(a.st.Path(DashboardFile))
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("redirect file: %v %v", fi, err)
	}
	page, _ := os.ReadFile(a.st.Path(DashboardFile))
	if !strings.Contains(string(page), d.base+"/#t="+tok) {
		t.Fatalf("redirect file does not open the fragment url:\n%s", page)
	}
	want(t, "state without a session", d.get("/api/state", ""), http.StatusUnauthorized)
	want(t, "a wrong token", d.post("/api/session", "", map[string]string{"token": "x" + tok}), http.StatusUnauthorized)
	bearer := d.login(tok)
	if !fileGone(t, a) {
		t.Fatal("the redirect file still holds the used token")
	}
	if s := d.state(bearer); s.Self.MeshID == "" || len(s.Members) != 1 {
		t.Fatalf("state %+v", s)
	}
	want(t, "the token a second time", d.post("/api/session", "", map[string]string{"token": tok}), http.StatusUnauthorized)

	// A new pen dashboard replaces an unused token; a token past 10 minutes is refused and its file goes.
	_, old := openDash(t, a)
	_, tok2 := openDash(t, a)
	want(t, "a replaced token", d.post("/api/session", "", map[string]string{"token": old}), http.StatusUnauthorized)
	clk.advance(DashboardTokenTTL)
	want(t, "an expired token", d.post("/api/session", "", map[string]string{"token": tok2}), http.StatusUnauthorized)
	if !fileGone(t, a) {
		t.Fatal("the redirect file outlived its expired token")
	}
}

func TestDashboardRejectsACookieOrMissingBearer(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	d, tok := openDash(t, a)
	bearer := d.login(tok)
	for name, set := range map[string]func(*http.Request){
		"cookie":          func(r *http.Request) { r.Header.Set("Cookie", "pen_dash="+bearer) },
		"wrong bearer":    func(r *http.Request) { r.Header.Set("Authorization", "Bearer x"+bearer) },
		"no scheme":       func(r *http.Request) { r.Header.Set("Authorization", bearer) },
		"basic":           func(r *http.Request) { r.Header.Set("Authorization", "Basic "+bearer) },
		"token as bearer": func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+tok) },
	} {
		want(t, name+" on state", d.send(http.MethodGet, "/api/state", "", nil, set), http.StatusUnauthorized)
		want(t, name+" on lock", d.send(http.MethodPost, "/api/lock", "", map[string]bool{"on": true}, set), http.StatusUnauthorized)
	}
	if a.ls(t).Locked {
		t.Fatal("a request without the bearer locked the mesh")
	}
}

func TestDashboardRejectsForeignHostAndOrigin(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	d, tok := openDash(t, a)
	port := strings.TrimPrefix(d.base, "http://127.0.0.1:")
	host := func(h string) func(*http.Request) { return func(r *http.Request) { r.Host = h } }
	origin := func(o string) func(*http.Request) {
		return func(r *http.Request) {
			if o == "" {
				r.Header.Del("Origin")
			} else {
				r.Header.Set("Origin", o)
			}
		}
	}
	for _, h := range []string{"evil.example:" + port, "127.0.0.1:1", "pen.localhost:" + port, "127.0.0.1"} {
		want(t, "page for host "+h, d.send(http.MethodGet, "/", "", nil, host(h)), http.StatusForbidden)
	}
	want(t, "page on localhost", d.send(http.MethodGet, "/", "", nil, host("localhost:"+port)), http.StatusOK)
	for _, o := range []string{"http://evil.example", "null", "", "http://localhost:" + port, "https://127.0.0.1:" + port} {
		want(t, "session from origin "+o, d.send(http.MethodPost, "/api/session", "", map[string]string{"token": tok}, origin(o)), http.StatusForbidden)
	}
	bearer := d.login(tok)
	want(t, "state for a rebound host", d.send(http.MethodGet, "/api/state", bearer, nil, host("evil.example:"+port)), http.StatusForbidden)
	for _, o := range []string{"http://evil.example", "null", ""} {
		want(t, "lock from origin "+o, d.send(http.MethodPost, "/api/lock", bearer, map[string]bool{"on": true}, origin(o)), http.StatusForbidden)
	}
	if a.ls(t).Locked {
		t.Fatal("a cross-origin request locked the mesh")
	}
	want(t, "a 17 KiB body", d.post("/api/relays", bearer, []byte(`{"relays":["`+strings.Repeat("a", 17<<10)+`"]}`)), http.StatusRequestEntityTooLarge)
	want(t, "a form post", d.send(http.MethodPost, "/api/lock", bearer, []byte("on=true"), func(r *http.Request) {
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}), http.StatusUnsupportedMediaType)
	want(t, "an unknown member", d.post("/api/lock", bearer, map[string]any{"on": true, "x": 1}), http.StatusBadRequest)
	pre := d.send(http.MethodOptions, "/api/lock", "", nil, func(r *http.Request) {
		r.Header.Set("Origin", "http://evil.example")
		r.Header.Set("Access-Control-Request-Method", "POST")
	})
	for _, r := range []reply{pre, d.get("/", ""), d.get("/api/state", bearer)} {
		if r.hdr.Get("Access-Control-Allow-Origin") != "" {
			t.Fatalf("CORS answered: %d %v", r.code, r.hdr)
		}
		h := r.hdr
		if !strings.Contains(h.Get("Content-Security-Policy"), "default-src 'self'") || !strings.Contains(h.Get("Content-Security-Policy"), "frame-ancestors 'none'") ||
			h.Get("X-Content-Type-Options") != "nosniff" || h.Get("Cache-Control") != "no-store" {
			t.Fatalf("headers %v", h)
		}
	}
	if pre.code/100 == 2 {
		t.Fatalf("preflight answered %d", pre.code)
	}
}

func TestDashboardApproveNeedsTheFullFingerprint(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := loginFake(t)
	a := founder(t, ctx, rs, "a", nil)
	bindTo(t, a, f, f.Key())
	d, tok := openDash(t, a)
	bearer := d.login(tok)
	want(t, "lock", d.post("/api/lock", bearer, map[string]bool{"on": true}), http.StatusOK)
	b := newcomer(t)
	as := f.Issue(testSub, "me@example.com", b.SignPub, b.NoisePub, time.Now())
	if _, _, err := AccountJoin(ctx, []string{rs.URL}, b, "b", as, offeredBy(t, a)); err != nil {
		t.Fatal(err)
	}
	fp := ident.Fingerprint(b.NoisePub)
	r := d.get("/api/state", bearer)
	var s DashState
	r.json(t, &s)
	if len(s.Pending) != 1 || s.Pending[0].ID != fp[:9] || s.Pending[0].Email != "me@example.com" {
		t.Fatalf("pending %+v", s.Pending)
	}
	if bytes.Contains(r.body, []byte(fp)) || bytes.Contains(r.body, []byte(NormalizeFingerprint(fp))) {
		t.Fatal("the state hands the page the full fingerprint the person must read on the new machine")
	}
	want(t, "approve by id", d.post("/api/approve", bearer, map[string]string{"fingerprint": fp[:9]}), http.StatusBadRequest)
	want(t, "approve by 9 groups", d.post("/api/approve", bearer, map[string]string{"fingerprint": fp[:len(fp)-5]}), http.StatusBadRequest)
	other := ident.Fingerprint(newcomer(t).NoisePub)
	want(t, "approve another fingerprint", d.post("/api/approve", bearer, map[string]string{"fingerprint": other}), http.StatusConflict)
	if n := len(a.ls(t).Members); n != 1 {
		t.Fatalf("%d members before the full fingerprint", n)
	}
	r = d.post("/api/approve", bearer, map[string]string{"fingerprint": strings.ToLower(fp)})
	want(t, "approve by the full fingerprint", r, http.StatusOK)
	var ar ApproveResult
	r.json(t, &ar)
	if ar.Member.Name != "b" || ar.Member.Via != mesh.ViaGoogle || len(a.ls(t).Members) != 2 {
		t.Fatalf("approved %+v; members %s", ar.Member, names(a.ls(t).Members))
	}
}

func TestDashboardRevokeNeedsTheMemberName(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	d, tok := openDash(t, a)
	bearer := d.login(tok)
	for _, name := range []string{"", "B", "a", "b "} {
		want(t, "revoke confirmed as "+name, d.post("/api/revoke", bearer, map[string]any{"nodeId": b.d.NodeID(), "compromised": false, "confirmName": name}), http.StatusBadRequest)
	}
	want(t, "revoke this node", d.post("/api/revoke", bearer, map[string]any{"nodeId": a.d.NodeID(), "compromised": false, "confirmName": "a"}), http.StatusConflict)
	if names(a.ls(t).Members) != "a,b" {
		t.Fatalf("members %s before a confirmed revoke", names(a.ls(t).Members))
	}
	want(t, "revoke b", d.post("/api/revoke", bearer, map[string]any{"nodeId": b.d.NodeID(), "compromised": false, "confirmName": "b"}), http.StatusOK)
	ls := a.ls(t)
	if names(ls.Members) != "a" || len(ls.Revoked) != 1 || ls.Revoked[0].Name != "b" {
		t.Fatalf("after revoke: members %s, revoked %+v", names(ls.Members), ls.Revoked)
	}
	// A machine found stolen after its plain revoke can still be revoked as compromised.
	want(t, "plain revoke of revoked b", d.post("/api/revoke", bearer, map[string]any{"nodeId": b.d.NodeID(), "compromised": false, "confirmName": "b"}), http.StatusConflict)
	want(t, "compromised revoke of revoked b", d.post("/api/revoke", bearer, map[string]any{"nodeId": b.d.NodeID(), "compromised": true, "confirmName": "b"}), http.StatusOK)
}

func TestDashboardLockAndRelaysUseTheDaemonOps(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs, rs2 := relaytest.New(), relaytest.New()
	defer rs.Close()
	defer rs2.Close()
	st := shortDir(t)
	id := identity(t, st, rs.URL, "a")
	if err := st.SaveConfig(state.Config{Relay: rs.URL, Name: "a", DownloadRelay: "https://dl.example"}); err != nil {
		t.Fatal(err)
	}
	if _, err := mesh.Found(st, id, "a", 1); err != nil {
		t.Fatal(err)
	}
	a := start(t, ctx, rs, st, nil)
	d, tok := openDash(t, a)
	bearer := d.login(tok)

	want(t, "lock on", d.post("/api/lock", bearer, map[string]bool{"on": true}), http.StatusOK)
	if !a.ls(t).Locked || !d.state(bearer).Locked {
		t.Fatal("lock on did not lock the mesh")
	}
	want(t, "lock off", d.post("/api/lock", bearer, map[string]bool{"on": false}), http.StatusOK)
	if a.ls(t).Locked {
		t.Fatal("lock off left the mesh locked")
	}

	for _, bad := range [][]string{{}, {"ftp://x.example"}, {rs.URL, rs.URL}} {
		want(t, "relays "+strings.Join(bad, " "), d.post("/api/relays", bearer, map[string][]string{"relays": bad}), http.StatusConflict)
	}
	want(t, "two relays", d.post("/api/relays", bearer, map[string][]string{"relays": {rs.URL, rs2.URL + "/"}}), http.StatusOK)
	cfg, err := st.LoadConfig()
	if err != nil || !slices.Equal(cfg.RelayList(), []string{rs.URL, rs2.URL}) || cfg.DownloadRelay != "https://dl.example" {
		t.Fatalf("config %+v %v", cfg, err)
	}
	if err := rs2.WaitOnline(ctx, a.d.NodeID()); err != nil {
		t.Fatal(err)
	}
	var rels []string
	for _, r := range d.state(bearer).Relays {
		rels = append(rels, r.URL)
	}
	if !slices.Equal(rels, []string{rs.URL, rs2.URL}) {
		t.Fatalf("state relays %v", rels)
	}

	r := d.post("/api/invite", bearer, map[string]int64{"ttlMs": time.Minute.Milliseconds()})
	want(t, "invite", r, http.StatusOK)
	var inv InviteReply
	r.json(t, &inv)
	if _, err := mesh.ParseToken(inv.Token); err != nil || inv.Command != "curl -fsSL https://dl.example/install.sh | sh -s -- --join "+inv.Token {
		t.Fatalf("invite %+v %v", inv, err)
	}
	var viaCLI InviteReply
	if err := Call(a.st, Request{Op: "invite"}, &viaCLI); err != nil || !strings.HasPrefix(viaCLI.Command, "curl -fsSL https://dl.example/install.sh ") {
		t.Fatalf("control invite %+v %v", viaCLI, err)
	}
	if s := d.state(bearer); s.LoginCommand != "curl -fsSL https://dl.example/install.sh | sh -s -- --login" {
		t.Fatalf("login command %q", s.LoginCommand)
	}
	want(t, "an invite for a week", d.post("/api/invite", bearer, map[string]int64{"ttlMs": (7 * 24 * time.Hour).Milliseconds()}), http.StatusBadRequest)
}

// pen relay download writes config.json while the daemon runs; the dashboard must use it and keep it.
func TestDashboardUsesADownloadRelaySetWhileRunningAndKeepsItOnARelayChange(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs, rs2 := relaytest.New(), relaytest.New()
	defer rs.Close()
	defer rs2.Close()
	a := founder(t, ctx, rs, "a", nil)
	cfg, err := a.st.LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	cfg.DownloadRelay = "https://dl.example"
	if err := a.st.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	d, tok := openDash(t, a)
	bearer := d.login(tok)
	if s := d.state(bearer); s.LoginCommand != LoginCommand("https://dl.example") {
		t.Fatalf("login command %q ignores the download relay set while running", s.LoginCommand)
	}
	want(t, "two relays", d.post("/api/relays", bearer, map[string][]string{"relays": {rs.URL, rs2.URL}}), http.StatusOK)
	if cfg, err := a.st.LoadConfig(); err != nil || cfg.DownloadRelay != "https://dl.example" {
		t.Fatalf("after a relays change: %+v %v", cfg, err)
	}
	r := d.post("/api/invite", bearer, map[string]int64{"ttlMs": time.Minute.Milliseconds()})
	var inv InviteReply
	r.json(t, &inv)
	if !strings.HasPrefix(inv.Command, "curl -fsSL https://dl.example/install.sh ") {
		t.Fatalf("invite command %q", inv.Command)
	}
}

func TestDashboardStateListsEventsFromRecords(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	clk := &clock{}
	clk.ms.Store(time.Now().UnixMilli())
	a := founder(t, ctx, rs, "a", clk)
	b := joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	d, tok := openDash(t, a)
	bearer := d.login(tok)
	// b's push reaches a through a's uplink, which carried a's first ping and its pong before.
	var pr map[string]any
	if err := Call(b.st, Request{Op: "push"}, &pr); err != nil {
		t.Fatal(err)
	}
	s := d.state(bearer)
	for _, m := range s.Members {
		if m.Name == "b" && (m.Relay != rs.URL || !m.Online) {
			t.Fatalf("member b %+v, want online via %s", m, rs.URL)
		}
	}
	if len(s.Relays) != 1 || s.Relays[0].Uplink != "up" || s.Relays[0].RTTMs < 1 {
		t.Fatalf("relays %+v", s.Relays)
	}
	clk.advance(time.Second)
	want(t, "lock", d.post("/api/lock", bearer, map[string]bool{"on": true}), http.StatusOK)
	clk.advance(time.Second)
	want(t, "revoke", d.post("/api/revoke", bearer, map[string]any{"nodeId": b.d.NodeID(), "compromised": true, "confirmName": "b"}), http.StatusOK)
	var got []string
	for _, e := range d.state(bearer).Events {
		s := e.Kind + ":" + strings.Join(e.Who, "+") + ":" + e.By
		if e.Via != "" {
			s += ":" + e.Via
		}
		if e.On != nil && *e.On {
			s += ":on"
		}
		if e.Compromised {
			s += ":compromised"
		}
		got = append(got, s)
	}
	exp := []string{"revoke:b:a:compromised", "lock::a:on", "admit:b:a:invite", "found:a:a"}
	if !slices.Equal(got, exp) {
		t.Fatalf("events %v, want %v", got, exp)
	}
}

func TestDashboardStopClosesServerAndSessions(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	d, tok := openDash(t, a)
	bearer := d.login(tok)
	openDash(t, a)
	var r map[string]bool
	if err := Call(a.st, Request{Op: "dashboard-stop"}, &r); err != nil || !r["stopped"] {
		t.Fatalf("stop: %v %v", r, err)
	}
	if !fileGone(t, a) {
		t.Fatal("the redirect file outlived the dashboard")
	}
	if _, err := d.c.Get(d.base + "/api/state"); err == nil {
		t.Fatal("the dashboard still answers after --stop")
	}
	d2, tok2 := openDash(t, a)
	want(t, "the old session on the new dashboard", d2.get("/api/state", bearer), http.StatusUnauthorized)
	d2.login(tok2)
}

func TestDashboardLogout(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	d, tok := openDash(t, a)
	bearer := d.login(tok)
	_, tok2 := openDash(t, a)
	other := d.login(tok2)
	want(t, "logout", d.post("/api/logout", bearer, nil), http.StatusOK)
	want(t, "state after logout", d.get("/api/state", bearer), http.StatusUnauthorized)
	want(t, "another session after logout", d.get("/api/state", other), http.StatusOK)
}

// rawGet sends one GET over conn and reads its response.
func rawGet(t *testing.T, conn net.Conn, host, path string) *http.Response {
	t.Helper()
	if _, err := fmt.Fprintf(conn, "GET %s HTTP/1.1\r\nHost: %s\r\n\r\n", path, host); err != nil {
		t.Fatal(err)
	}
	res, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	return res
}

// readsEOF reports whether the server closed conn: a read returns EOF (or a reset) instead of data.
func readsEOF(conn net.Conn) bool {
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, err := conn.Read(make([]byte, 1))
	return err != nil && !errors.Is(err, os.ErrDeadlineExceeded)
}

func TestDashboardRejectionsCloseTheConnection(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	d, _ := openDash(t, a)
	addr := strings.TrimPrefix(d.base, "http://")
	for _, c := range []struct {
		host, path string
		code       int
	}{
		{"evil.example:" + strings.Split(addr, ":")[1], "/", http.StatusForbidden},
		{addr, "/api/state", http.StatusUnauthorized},
	} {
		conn, err := net.Dial("tcp", addr)
		if err != nil {
			t.Fatal(err)
		}
		res := rawGet(t, conn, c.host, c.path)
		if res.StatusCode != c.code || !res.Close {
			t.Fatalf("%s %s: %d, Connection: close %v; want %d and a closed connection", c.host, c.path, res.StatusCode, res.Close, c.code)
		}
		if !readsEOF(conn) {
			t.Fatalf("%s %s: the server kept the rejected connection open", c.host, c.path)
		}
		conn.Close()
	}
}

func TestDashboardIdleConnectionsDoNotLockThePageOut(t *testing.T) {
	if dashIdleTimeout != 5*time.Second {
		t.Fatalf("idle timeout %v, want 5s", dashIdleTimeout)
	}
	defer func(old time.Duration) { dashIdleTimeout = old }(dashIdleTimeout)
	dashIdleTimeout = 300 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	d, _ := openDash(t, a)
	addr := strings.TrimPrefix(d.base, "http://")
	var held []net.Conn
	for range dashMaxConns {
		conn, err := net.Dial("tcp", addr)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		if res := rawGet(t, conn, addr, "/"); res.StatusCode != http.StatusOK || res.Close {
			t.Fatalf("held connection: %d close %v", res.StatusCode, res.Close)
		}
		held = append(held, conn)
	}
	extra, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	if !readsEOF(extra) {
		t.Fatal("a 17th connection was served while 16 were held")
	}
	extra.Close()
	// The server ends each held connection once it has been idle for dashIdleTimeout.
	for _, conn := range held {
		if !readsEOF(conn) {
			t.Fatal("an idle connection outlived the idle timeout")
		}
	}
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if res := rawGet(t, conn, addr, "/"); res.StatusCode != http.StatusOK {
		t.Fatalf("after the idle timeout: %d", res.StatusCode)
	}
}

// loginServer exchanges tok and returns the bearer and the server id the page checks responses against.
func (d *dash) loginServer(tok string) (bearer, server string) {
	d.t.Helper()
	r := d.post("/api/session", "", map[string]string{"token": tok})
	var out struct{ Bearer, Server string }
	r.json(d.t, &out)
	if r.code != http.StatusOK || out.Bearer == "" {
		d.t.Fatalf("session: %d %s", r.code, r.body)
	}
	return out.Bearer, out.Server
}

// The page trusts only responses that carry its session's server id, so a program that takes the
// port after the dashboard stops cannot pass for it.
func TestDashboardEveryAPIResponseCarriesTheSessionsServerID(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	d, tok := openDash(t, a)
	bearer, server := d.loginServer(tok)
	if len(server) != 43 {
		t.Fatalf("/api/session server id %q, want 32 bytes base64url", server)
	}
	_, tok2 := openDash(t, a)
	if _, other := d.loginServer(tok2); other == server {
		t.Fatal("two sessions share a server id")
	}
	port := strings.TrimPrefix(d.base, "http://127.0.0.1:")
	check := func(what string, r reply, code int) {
		t.Helper()
		want(t, what, r, code)
		if got := r.hdr.Get("X-Pen-Server"); got != server {
			t.Fatalf("%s: X-Pen-Server %q, want the session's %q", what, got, server)
		}
	}
	check("state", d.get("/api/state", bearer), http.StatusOK)
	check("unknown member", d.post("/api/lock", bearer, map[string]any{"on": true, "x": 1}), http.StatusBadRequest)
	check("foreign host", d.send(http.MethodGet, "/api/state", bearer, nil, func(r *http.Request) { r.Host = "evil.example:" + port }), http.StatusForbidden)
	check("revoke a stranger", d.post("/api/revoke", bearer, map[string]any{"nodeId": "x", "compromised": false, "confirmName": "x"}), http.StatusConflict)
	check("17 KiB", d.post("/api/relays", bearer, []byte(`{"relays":["`+strings.Repeat("a", 17<<10)+`"]}`)), http.StatusRequestEntityTooLarge)
	check("form post", d.send(http.MethodPost, "/api/lock", bearer, []byte("on=true"), func(r *http.Request) {
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}), http.StatusUnsupportedMediaType)
	check("logout", d.post("/api/logout", bearer, nil), http.StatusOK)
	check("state after logout", d.get("/api/state", bearer), http.StatusUnauthorized)
	if r := d.get("/api/state", ""); r.code != http.StatusUnauthorized || r.hdr.Get("X-Pen-Server") != "" {
		t.Fatalf("a caller without the bearer got %d with server id %q", r.code, r.hdr.Get("X-Pen-Server"))
	}
}
