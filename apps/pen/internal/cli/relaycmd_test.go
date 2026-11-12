package cli

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/relayserver"
	"github.com/goat-si/goat/apps/pen/internal/state"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

func TestRelayServeFlagsAreValidatedWithoutACME(t *testing.T) {
	bad := map[string][]string{
		"no mode":                 {"--listen", ":0"},
		"two modes":               {"--plain", "--cert", "c", "--key", "k"},
		"autocert without cache":  {"--autocert", "1-2-3-4.sslip.io"},
		"autocert with an IP":     {"--autocert", "1.2.3.4", "--cache", "/tmp/x"},
		"cache without autocert":  {"--plain", "--cache", "/tmp/x"},
		"cert without key":        {"--cert", "c"},
		"origin with a path":      {"--plain", "--public-origin", "wss://relay.example/x"},
		"origin not normalized":   {"--plain", "--public-origin", "wss://Relay.example:443"},
		"cert without an origin":  {"--cert", "c", "--key", "k", "--listen", ":8443"},
		"plain on every address":  {"--plain", "--listen", ":8080"},
		"autocert origin differs": {"--autocert", "a.sslip.io", "--cache", "/tmp/x", "--public-origin", "wss://b.sslip.io"},
		"autocert off port 443":   {"--autocert", "a.sslip.io", "--cache", "/tmp/x", "--listen", ":8443"},
		"zero socket cap":         {"--plain", "--listen", "127.0.0.1:0", "--max-sockets", "0"},
		"negative per-IP cap":     {"--plain", "--listen", "127.0.0.1:0", "--max-per-ip", "-1"},
		"zero queue budget":       {"--plain", "--listen", "127.0.0.1:0", "--max-queued-mib", "0"},
		"zero source share":       {"--plain", "--listen", "127.0.0.1:0", "--max-queued-per-source-mib", "0"},
		"zero unauth cap":         {"--plain", "--listen", "127.0.0.1:0", "--max-unauth-per-node", "0"},
	}
	for name, args := range bad {
		if _, err := parseServe(args, &bytes.Buffer{}); err == nil {
			t.Fatalf("%s: accepted %v", name, args)
		}
	}
	good := [][]string{
		{"--autocert", "203-0-113-7.sslip.io", "--cache", "/tmp/pen-acme"},
		{"--cert", "c.pem", "--key", "k.pem", "--listen", ":8443", "--public-origin", "wss://relay.example:8443"},
		{"--plain", "--listen", ":8080", "--public-origin", "wss://relay.example"},
		{"--plain", "--listen", "127.0.0.1:0"},
	}
	for _, args := range good {
		if _, err := parseServe(args, &bytes.Buffer{}); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
	}
}

func TestAutocertIssuesForItsOneHostOnly(t *testing.T) {
	c, err := parseServe([]string{"--autocert", "203-0-113-7.sslip.io", "--cache", t.TempDir()}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	m := autocertManager(c)
	if err := m.HostPolicy(context.Background(), "203-0-113-7.sslip.io"); err != nil {
		t.Fatalf("own host refused: %v", err)
	}
	if err := m.HostPolicy(context.Background(), "attacker.example"); err == nil {
		t.Fatal("another host would get a certificate")
	}
}

// selfSigned writes a certificate for 127.0.0.1 and returns its pool.
func selfSigned(t *testing.T, dir string) (certFile, keyFile string, pool *x509.CertPool) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "pen test"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, KeyUsage: x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	kder, _ := x509.MarshalECPrivateKey(key)
	certFile, keyFile = filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600)
	os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kder}), 0o600)
	cert, _ := x509.ParseCertificate(der)
	pool = x509.NewCertPool()
	pool.AddCert(cert)
	return certFile, keyFile, pool
}

func TestRelayServeWithCertAndKeyBindsUplinksToItsPublicOrigin(t *testing.T) {
	certFile, keyFile, pool := selfSigned(t, t.TempDir())
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	origin := "wss://" + addr
	c, err := parseServe([]string{"--cert", certFile, "--key", keyFile, "--listen", addr, "--public-origin", origin}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	online := make(chan string, 4)
	go serveOn(ctx, c, ln, nil, relayserver.Hooks{OnUplink: func(id string) { online <- id }})
	url := "https://" + addr
	tlsConf := &tls.Config{RootCAs: pool}
	relay.TLSConfig = tlsConf
	defer func() { relay.TLSConfig = nil }()
	id, _ := ident.Generate(nil)
	up := relay.NewUplink(url, id)
	go up.Run(ctx)
	if got := <-online; got != id.NodeID() {
		t.Fatalf("online %s", got)
	}
	conn, err := relay.Dial(ctx, url, id.NodeID())
	if err != nil {
		t.Fatal(err)
	}
	n, err := up.Accept(ctx)
	if err != nil {
		t.Fatal(err)
	}
	conn.Send([]byte("over tls"))
	if p, err := n.Recv(ctx); err != nil || string(p) != "over tls" {
		t.Fatalf("node got %q, %v", p, err)
	}

	client := &http.Client{Transport: &http.Transport{TLSClientConfig: tlsConf}}
	other, _ := ident.Generate(nil)
	wsURL := "wss://" + addr + "/v1/node/" + other.NodeID()
	// Another Host on the same TLS listener is refused before any upgrade.
	_, res, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPClient: client, Host: "other.example"})
	if err == nil || res == nil || res.StatusCode != http.StatusMisdirectedRequest {
		t.Fatalf("Host other.example: %v, want 421", err)
	}
	// A signature over another origin does not authenticate.
	ws, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		t.Fatal(err)
	}
	_, challenge, err := ws.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	sig := ed25519.Sign(other.SignPriv, wire.ChallengeMessage("wss://other.example", other.NodeID(), challenge))
	ws.Write(ctx, websocket.MessageBinary, append(append([]byte(nil), other.SignPub...), sig...))
	if _, _, err := ws.Read(ctx); websocket.CloseStatus(err) != websocket.StatusCode(wire.CodeRelayAuth) {
		t.Fatalf("signature over wss://other.example: %v, want 4403", err)
	}
}

func TestRelayAddKeepsConcurrentOfflineAdd(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PEN_HOME", dir)
	st, err := state.OpenDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	c := state.Config{Name: "a"}
	c.SetRelays([]string{"https://a.example"})
	if err := st.SaveConfig(c); err != nil {
		t.Fatal(err)
	}
	afterRelayConfigRead = func() {
		afterRelayConfigRead = nil
		var out, errOut bytes.Buffer
		if code := RunRelay([]string{"add", "https://c.example"}, &out, &errOut); code != 0 {
			t.Fatalf("second add: %d %s", code, errOut.String())
		}
	}
	t.Cleanup(func() { afterRelayConfigRead = nil })
	var out, errOut bytes.Buffer
	if code := RunRelay([]string{"add", "https://b.example"}, &out, &errOut); code != 0 {
		t.Fatalf("first add: %d %s", code, errOut.String())
	}
	got, err := st.LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if list := strings.Join(got.RelayList(), ","); list != "https://a.example,https://c.example,https://b.example" {
		t.Fatalf("relays after both adds: %s", list)
	}
}

func TestRelayEditChecksLockedConfig(t *testing.T) {
	for _, tt := range []struct {
		name, verb, url, message string
		initial, updated, want   []string
		code                     int
	}{
		{"already added", "add", "https://b.example", "already a relay", []string{"https://a.example"}, []string{"https://a.example", "https://b.example"}, []string{"https://a.example", "https://b.example"}, 0},
		{"already removed", "rm", "https://b.example", "not one of this node's relays", []string{"https://a.example", "https://b.example"}, []string{"https://a.example"}, []string{"https://a.example"}, 1},
		{"last relay", "rm", "https://b.example", "needs at least one relay", []string{"https://a.example", "https://b.example"}, []string{"https://b.example"}, []string{"https://b.example"}, 1},
		{"invalid duplicate origin", "add", "wss://B.example:443", "", []string{"https://a.example"}, []string{"https://a.example", "https://b.example"}, []string{"https://a.example", "https://b.example"}, 1},
	} {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("PEN_HOME", dir)
			st, err := state.OpenDir(dir)
			if err != nil {
				t.Fatal(err)
			}
			c := state.Config{Name: "a"}
			c.SetRelays(tt.initial)
			if err := st.SaveConfig(c); err != nil {
				t.Fatal(err)
			}
			afterRelayConfigRead = func() {
				if err := st.UpdateConfig(func(c *state.Config) { c.SetRelays(tt.updated) }); err != nil {
					t.Fatal(err)
				}
			}
			t.Cleanup(func() { afterRelayConfigRead = nil })
			var out, errOut bytes.Buffer
			if code := RunRelay([]string{tt.verb, tt.url}, &out, &errOut); code != tt.code {
				t.Fatalf("exit %d, want %d: %s", code, tt.code, errOut.String())
			}
			if !strings.Contains(out.String()+errOut.String(), tt.message) {
				t.Fatalf("output: %s %s", &out, &errOut)
			}
			got, err := st.LoadConfig()
			if err != nil {
				t.Fatal(err)
			}
			if strings.Join(got.RelayList(), ",") != strings.Join(tt.want, ",") {
				t.Fatalf("relays: %v, want %v", got.RelayList(), tt.want)
			}
		})
	}
}

// An offline edit that changes nothing (already a relay, not a relay, the last one, invalid) leaves
// config.json exactly as it was, including fields this binary does not know.
func TestARefusedOfflineRelayEditLeavesTheConfigUntouched(t *testing.T) {
	for _, args := range [][]string{
		{"add", "https://a.example"},
		{"rm", "https://x.example"},
		{"rm", "https://a.example"},
		{"add", "wss://A.example:443"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("PEN_HOME", dir)
			st, err := state.OpenDir(dir)
			if err != nil {
				t.Fatal(err)
			}
			raw := []byte(`{"name":"a","relays":["https://a.example"],"relay":"https://a.example","future":1}`)
			if err := os.WriteFile(st.Path("config.json"), raw, 0o600); err != nil {
				t.Fatal(err)
			}
			var out, errOut bytes.Buffer
			RunRelay(args, &out, &errOut)
			got, err := os.ReadFile(st.Path("config.json"))
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, raw) {
				t.Fatalf("config.json rewritten: %s", got)
			}
		})
	}
}

func TestRelayAddRmEditTheConfigAndKeepAtLeastOne(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PEN_HOME", dir)
	st, _ := state.OpenDir(dir)
	c := state.Config{Name: "a"}
	c.SetRelays([]string{"https://a.example"})
	st.SaveConfig(c)
	var out, errOut bytes.Buffer
	if code := RunRelay([]string{"add", "https://b.example/"}, &out, &errOut); code != 0 {
		t.Fatalf("add: %d %s", code, errOut.String())
	}
	if code := RunRelay([]string{"add", "http://c.example"}, &out, &errOut); code == 0 {
		t.Fatal("plain http to a public host accepted in a relay list")
	}
	if code := RunRelay([]string{"add", "wss://B.example:443"}, &out, &errOut); code == 0 {
		t.Fatal("the same relay under another spelling was added")
	}
	if code := RunRelay([]string{"rm", "https://a.example"}, &out, &errOut); code != 0 {
		t.Fatalf("rm: %d %s", code, errOut.String())
	}
	if code := RunRelay([]string{"rm", "https://b.example"}, &out, &errOut); code == 0 {
		t.Fatal("removed the last relay")
	}
	got, _ := st.LoadConfig()
	if strings.Join(got.RelayList(), ",") != "https://b.example" || got.Relay != "https://b.example" {
		t.Fatalf("config %+v", got)
	}
}

// lockProbe is command output that, on every write, checks whether another holder could take the
// state lock right then.
type lockProbe struct {
	path         string
	writes, held int
}

func (p *lockProbe) Write(b []byte) (int, error) {
	p.writes++
	if unlock, err := state.TryLock(p.path); err != nil {
		p.held++
	} else {
		unlock()
	}
	return len(b), nil
}

// Regression #2934: an offline relay edit releases the state lock before it writes its result, so
// output nobody reads cannot hold up every other config writer.
func TestAnOfflineRelayEditReleasesTheStateLockBeforeItPrints(t *testing.T) {
	for _, args := range [][]string{
		{"add", "https://b.example"},
		{"add", "https://a.example"},
		{"rm", "https://x.example"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("PEN_HOME", dir)
			st, err := state.OpenDir(dir)
			if err != nil {
				t.Fatal(err)
			}
			c := state.Config{Name: "a"}
			c.SetRelays([]string{"https://a.example"})
			if err := st.SaveConfig(c); err != nil {
				t.Fatal(err)
			}
			out := &lockProbe{path: st.Path("state.lock")}
			RunRelay(args, out, out)
			if out.writes == 0 || out.held != 0 {
				t.Fatalf("%d of %d writes ran while the state lock was held", out.held, out.writes)
			}
		})
	}
}

func TestRelayServeCapFlagsReachTheRelay(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	c, err := parseServe([]string{"--plain", "--listen", ln.Addr().String(), "--max-per-ip", "1"}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go serveOn(ctx, c, ln, nil, relayserver.Hooks{})
	dialUplink := func() int {
		id, _ := ident.Generate(nil)
		ws, res, err := websocket.Dial(ctx, "ws://"+ln.Addr().String()+"/v1/node/"+id.NodeID(), nil)
		if err != nil {
			if res == nil {
				t.Fatal(err)
			}
			return res.StatusCode
		}
		t.Cleanup(func() { ws.CloseNow() })
		return http.StatusSwitchingProtocols
	}
	if got := dialUplink(); got != http.StatusSwitchingProtocols {
		t.Fatalf("first socket got %d", got)
	}
	id, _ := ident.Generate(nil)
	if ws, _, err := websocket.Dial(ctx, "ws://"+ln.Addr().String()+"/v1/node/"+id.NodeID(), nil); err == nil {
		ws.CloseNow()
		t.Fatal("a second socket from 127.0.0.1 with --max-per-ip 1 was served")
	}
}

// A connection holds memory from accept on, while it sends its TLS handshake and headers, so the
// caps count it from there: a source whose connections have sent nothing yet still uses its share.
func TestConnectionsCountTowardTheCapsBeforeTheirRequestArrives(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	c, err := parseServe([]string{"--plain", "--listen", ln.Addr().String(), "--max-per-ip", "1"}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go serveOn(ctx, c, ln, nil, relayserver.Hooks{})
	silent, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer silent.Close()
	id, _ := ident.Generate(nil)
	ws, _, err := websocket.Dial(ctx, "ws://"+ln.Addr().String()+"/v1/node/"+id.NodeID(), nil)
	if err == nil {
		ws.CloseNow()
		t.Fatal("a second connection from 127.0.0.1 with --max-per-ip 1 was served while the first had sent nothing")
	}
}

func TestUpgradedSocketsOutliveTheHTTPServersReadTimeout(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	c, err := parseServe([]string{"--plain", "--listen", ln.Addr().String()}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	c.readTimeout = 200 * time.Millisecond
	l := relayserver.DefaultLimits()
	l.PendingTimeout = 600 * time.Millisecond
	c.limits = &l
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	online := make(chan string, 1)
	go serveOn(ctx, c, ln, nil, relayserver.Hooks{OnUplink: func(id string) { online <- id }})
	url := "http://" + ln.Addr().String()
	id, _ := ident.Generate(nil)
	up := relay.NewUplink(url, id)
	go up.Run(ctx)
	<-online
	conn, err := relay.Dial(ctx, url, id.NodeID())
	if err != nil {
		t.Fatal(err)
	}
	// The node never answers, so the relay ends the session 4408 at 600 ms, past the 200 ms read
	// timeout; 4404 or 1006 would mean the uplink or the client died at the HTTP deadline.
	if _, err := conn.Recv(ctx); relay.CodeOf(err) != wire.CodeTimeout {
		t.Fatalf("pending session ended with %v, want 4408", err)
	}
}

func TestAutocertCacheIsAPrivateDirectory(t *testing.T) {
	loose := filepath.Join(t.TempDir(), "acme")
	if err := os.Mkdir(loose, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := prepareCache(loose); err != nil {
		t.Fatal(err)
	}
	if private, err := state.OwnerOnly(loose); err != nil || !private {
		t.Fatalf("cache is not private to its owner: %v", err)
	}
	fresh := filepath.Join(t.TempDir(), "new", "acme")
	if err := prepareCache(fresh); err != nil {
		t.Fatal(err)
	}
	if private, err := state.OwnerOnly(fresh); err != nil || !private {
		t.Fatalf("new cache is not private to its owner: %v", err)
	}
	file := filepath.Join(t.TempDir(), "file")
	os.WriteFile(file, nil, 0o600)
	if err := prepareCache(file); err == nil {
		t.Fatal("a file was accepted as the cache directory")
	}
}

func TestRelayDownloadTakesOnlyAnHTTPSOriginOrALoopbackHTTPOne(t *testing.T) {
	t.Setenv("PEN_HOME", t.TempDir())
	for _, bad := range []string{
		"http://relay.example", "wss://relay.example", "https://relay.example/dl", "https://relay.example?x=1",
		"https://relay.example#top", "https://user@relay.example", "relay.example", "https://",
		// Invites print it into a curl | sh line, so a host must not carry shell syntax.
		"https://a;b", "https://a$(id)", "https://a&b", "https://a'b", "https://a%20b", "https://a`id`",
	} {
		var out, errOut bytes.Buffer
		if code := RunRelay([]string{"download", bad}, &out, &errOut); code == 0 {
			t.Errorf("pen relay download %s was accepted", bad)
		}
	}
	for url, want := range map[string]string{
		"https://relay.example/": "https://relay.example",
		"http://127.0.0.1:8787":  "http://127.0.0.1:8787",
	} {
		var out, errOut bytes.Buffer
		if code := RunRelay([]string{"download", url}, &out, &errOut); code != 0 {
			t.Fatalf("pen relay download %s: exit %d: %s", url, code, errOut.String())
		}
		out.Reset()
		RunRelay([]string{"download"}, &out, &errOut)
		if got := strings.TrimSpace(out.String()); got != want {
			t.Fatalf("after setting %s the download relay is %q, want %q", url, got, want)
		}
	}
}

// The node list is operator input: full node ids, comma-separated (the unit passes an empty one
// when none is set); anything else is refused, so a typo never silently tracks nothing.
func TestTrafficNodesTakeFullNodeIDsOnly(t *testing.T) {
	a, _ := ident.Generate(rand.Reader)
	b, _ := ident.Generate(rand.Reader)
	base := []string{"--plain", "--listen", "127.0.0.1:0"}
	c, err := parseServe(append(base, "--traffic-nodes="+a.NodeID()+", "+b.NodeID()), &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if len(c.trafficNodes) != 2 || !c.trafficNodes[a.NodeID()] || !c.trafficNodes[b.NodeID()] {
		t.Fatalf("traffic nodes %v", c.trafficNodes)
	}
	if c, err := parseServe(append(base, "--traffic-nodes="), &bytes.Buffer{}); err != nil || len(c.trafficNodes) != 0 {
		t.Fatalf("an empty list: %v %v", c.trafficNodes, err)
	}
	for _, bad := range []string{a.NodeID()[:8], strings.ToUpper(a.NodeID()), a.NodeID() + ";" + b.NodeID()} {
		if _, err := parseServe(append(base, "--traffic-nodes="+bad), &bytes.Buffer{}); err == nil {
			t.Fatalf("accepted --traffic-nodes=%s", bad)
		}
	}
}
