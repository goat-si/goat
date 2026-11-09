package cli

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/relayserver"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

func TestRelayServeFlagsAreValidatedWithoutACME(t *testing.T) {
	bad := map[string][]string{
		"no mode":                {"--listen", ":0"},
		"two modes":              {"--plain", "--cert", "c", "--key", "k"},
		"autocert without cache": {"--autocert", "1-2-3-4.sslip.io"},
		"autocert with an IP":    {"--autocert", "1.2.3.4", "--cache", "/tmp/x"},
		"cache without autocert": {"--plain", "--cache", "/tmp/x"},
		"cert without key":       {"--cert", "c"},
		"origin with a path":     {"--plain", "--public-origin", "wss://relay.example/x"},
		"origin not normalized":  {"--plain", "--public-origin", "wss://Relay.example:443"},
	}
	for name, args := range bad {
		if _, err := parseServe(args, &bytes.Buffer{}); err == nil {
			t.Fatalf("%s: accepted %v", name, args)
		}
	}
	good := [][]string{
		{"--autocert", "203-0-113-7.sslip.io", "--cache", "/tmp/pen-acme"},
		{"--cert", "c.pem", "--key", "k.pem", "--listen", ":8443"},
		{"--plain", "--listen", "127.0.0.1:0", "--public-origin", "wss://relay.example"},
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

func TestRelayServeWithCertAndKeyAuthenticatesAWssUplink(t *testing.T) {
	certFile, keyFile, pool := selfSigned(t, t.TempDir())
	c, err := parseServe([]string{"--cert", certFile, "--key", keyFile, "--listen", "127.0.0.1:0"}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	addr := make(chan string, 1)
	online := make(chan string, 1)
	go serve(ctx, c, func(a string) { addr <- a }, relayserver.Hooks{OnUplink: func(id string) { online <- id }})
	url := "https://" + <-addr
	relay.TLSConfig = &tls.Config{RootCAs: pool}
	defer func() { relay.TLSConfig = nil }()
	id, _ := ident.Generate(nil)
	up := relay.NewUplink(url, id)
	go up.Run(ctx)
	// The relay authenticates the uplink only if it signed wss://127.0.0.1:<port>, the origin of TLS.
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
