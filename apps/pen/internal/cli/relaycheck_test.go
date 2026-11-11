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
	"math/big"
	"net"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
)

func TestRelayCheckMovesBytesBothWaysThroughAWorkingRelay(t *testing.T) {
	t.Setenv("PEN_HOME", t.TempDir())
	rs := relaytest.New()
	defer rs.Close()
	var out, errOut bytes.Buffer
	if code := RunRelay([]string{"check", rs.URL}, &out, &errOut); code != 0 {
		t.Fatalf("check of a working relay: exit %d\n%s%s", code, out.String(), errOut.String())
	}
	for _, want := range []string{"ok: healthz", "ok: the check node", "64 KiB each way"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("output lacks %q:\n%s", want, out.String())
		}
	}
}

func TestRelayCheckFailsWhenTheRelayIsDown(t *testing.T) {
	t.Setenv("PEN_HOME", t.TempDir())
	rs := relaytest.New()
	url := rs.URL
	rs.Close()
	var out, errOut bytes.Buffer
	if code := RunRelay([]string{"check", "--timeout", "5s", url}, &out, &errOut); code != 1 {
		t.Fatalf("check of a stopped relay: exit %d\n%s%s", code, out.String(), errOut.String())
	}
}

// The served certificate's expiry is the operator's renewal alarm: autocert retries a failed renewal
// silently, so the check fails while there is still time to act.
func TestRelayCheckFailsWhenTheCertificateExpiresSoon(t *testing.T) {
	t.Setenv("PEN_HOME", t.TempDir())
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "127.0.0.1"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(5 * 24 * time.Hour),
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IsCA: true, BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, _ := x509.ParseCertificate(der)
	pool := x509.NewCertPool()
	pool.AddCert(leaf)
	old := relay.TLSConfig
	relay.TLSConfig = &tls.Config{RootCAs: pool}
	defer func() { relay.TLSConfig = old }()

	rs := relaytest.NewUnstarted()
	ts := httptest.NewUnstartedServer(rs.Relay)
	ts.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
	ts.StartTLS()
	defer ts.Close()

	var out, errOut bytes.Buffer
	if code := RunRelay([]string{"check", ts.URL}, &out, &errOut); code != 1 || !strings.Contains(errOut.String(), "expires in 4 days") {
		t.Fatalf("certificate 5 days from expiry: exit %d\n%s%s", code, out.String(), errOut.String())
	}
	out.Reset()
	errOut.Reset()
	if code := RunRelay([]string{"check", "--min-cert-days", "3", ts.URL}, &out, &errOut); code != 0 {
		t.Fatalf("same relay with a 3-day threshold: exit %d\n%s%s", code, out.String(), errOut.String())
	}
}

// Two checks from one machine at once (two cron jobs, or a person and a probe) share the check node;
// the second must wait for the first instead of replacing its uplink (4409) and failing both.
func TestOverlappingRelayChecksFromOneMachineBothPass(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	t.Setenv("PEN_HOME", t.TempDir())
	rs := relaytest.New()
	defer rs.Close()
	id, release, err := checkIdentity(ctx)
	if err != nil {
		t.Fatal(err)
	}
	release()
	waiting := make(chan struct{}, 2)
	beforeCheckHold = func() { waiting <- struct{}{} }
	defer func() { beforeCheckHold = func() {} }()
	// The first check stalls mid-session, holding the check node, until forwarding resumes.
	resume := rs.HoldForwarding()
	defer resume()
	type result struct {
		code     int
		out, err string
	}
	results := make(chan result, 2)
	check := func() {
		var out, errOut bytes.Buffer
		code := RunRelay([]string{"check", rs.URL}, &out, &errOut)
		results <- result{code, out.String(), errOut.String()}
	}
	go check()
	<-waiting
	if err := rs.NextClientMessage(ctx, id.NodeID()); err != nil {
		t.Fatal(err)
	}
	go check()
	<-waiting
	resume()
	for range 2 {
		if r := <-results; r.code != 0 {
			t.Fatalf("one of two overlapping checks: exit %d\n%s%s", r.code, r.out, r.err)
		}
	}
}

// A relay that accepts the sockets but stops forwarding ends the check at --timeout with a reason.
func TestRelayCheckGivesUpAtItsTimeoutWhenTheRelayStopsForwarding(t *testing.T) {
	t.Setenv("PEN_HOME", t.TempDir())
	rs := relaytest.New()
	defer rs.Close()
	release := rs.HoldForwarding()
	defer release()
	var out, errOut bytes.Buffer
	if code := RunRelay([]string{"check", "--timeout", "2s", rs.URL}, &out, &errOut); code != 1 || !strings.Contains(errOut.String(), "before --timeout") {
		t.Fatalf("check through a relay that holds every message: exit %d\n%s%s", code, out.String(), errOut.String())
	}
}
