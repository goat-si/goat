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
	if fi, _ := os.Stat(loose); fi.Mode().Perm() != 0o700 {
		t.Fatalf("cache mode %v, want 0700", fi.Mode().Perm())
	}
	fresh := filepath.Join(t.TempDir(), "new", "acme")
	if err := prepareCache(fresh); err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Stat(fresh); err != nil || fi.Mode().Perm() != 0o700 {
		t.Fatalf("new cache: %v %v", fi, err)
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
