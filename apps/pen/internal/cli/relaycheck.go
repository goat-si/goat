package cli

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/state"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// checkChunk and checkChunks make the 64 KiB the check moves each way.
const (
	checkChunk  = 4 << 10
	checkChunks = 16
)

// runRelayCheck proves a relay end to end: /healthz answers, its certificate has time left, and the
// machine's check node can uplink and exchange bytes with a client through it.
func runRelayCheck(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("relay check", flag.ContinueOnError)
	fs.SetOutput(stderr)
	timeout := fs.Duration("timeout", 30*time.Second, "give up after this long")
	minDays := fs.Int("min-cert-days", 14, "fail when the TLS certificate expires sooner")
	if err := fs.Parse(args); err != nil || fs.NArg() != 1 {
		fmt.Fprintln(stderr, "usage: pen relay check [--timeout 30s] [--min-cert-days 14] <relay URL>")
		return 2
	}
	relayURL := strings.TrimRight(fs.Arg(0), "/")
	if _, err := wire.RelayOrigin(relayURL); err != nil {
		fmt.Fprintf(stderr, "pen relay check: %v\n", err)
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	failed := false
	notAfter, err := checkHealth(ctx, relayURL, stdout)
	if err != nil {
		fmt.Fprintf(stderr, "FAIL: healthz: %v\n", err)
		return 1
	}
	if !notAfter.IsZero() {
		days := int(time.Until(notAfter) / (24 * time.Hour))
		if days < *minDays {
			fmt.Fprintf(stderr, "FAIL: the certificate expires in %d days (%s); renewal is overdue, see the relay's journal\n",
				days, notAfter.UTC().Format(time.DateOnly))
			failed = true
		} else {
			fmt.Fprintf(stdout, "ok: certificate valid until %s (%d days)\n", notAfter.UTC().Format(time.DateOnly), days)
		}
	}
	if err := checkRoundTrip(ctx, relayURL, stdout); err != nil {
		fmt.Fprintf(stderr, "FAIL: %v\n", err)
		failed = true
	}
	if failed {
		return 1
	}
	return 0
}

// checkHealth fetches /healthz and returns the served certificate's expiry (zero for plain http).
func checkHealth(ctx context.Context, relayURL string, stdout io.Writer) (time.Time, error) {
	u, err := url.Parse(relayURL)
	if err != nil {
		return time.Time{}, err
	}
	switch u.Scheme {
	case "wss":
		u.Scheme = "https"
	case "ws":
		u.Scheme = "http"
	}
	u.Path = "/healthz"
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: relay.TLSConfig}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return time.Time{}, err
	}
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return time.Time{}, err
	}
	defer resp.Body.Close()
	var body struct {
		OK      bool   `json:"ok"`
		Version string `json:"version"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&body) != nil || !body.OK {
		return time.Time{}, fmt.Errorf("%s answered HTTP %d without {\"ok\":true}", u, resp.StatusCode)
	}
	fmt.Fprintf(stdout, "ok: healthz %s in %d ms\n", body.Version, time.Since(start).Milliseconds())
	if resp.TLS == nil || len(resp.TLS.PeerCertificates) == 0 {
		return time.Time{}, nil
	}
	return resp.TLS.PeerCertificates[0].NotAfter, nil
}

// checkIdentity is the node the check uplinks as: one per machine, kept in relay-check/ under the
// state directory and never the machine's own node (its uplink would replace the real one, 4409).
// Relays keep a little state per node id, so a fresh identity per run would pile it up. The
// returned release ends this check's hold on the node: a second check on the machine waits for it,
// since its uplink would replace this one's.
func checkIdentity(ctx context.Context) (*ident.Identity, func(), error) {
	dir, err := state.Dir()
	if err != nil {
		return nil, nil, err
	}
	st, err := state.OpenDir(filepath.Join(dir, "relay-check"))
	if err != nil {
		return nil, nil, fmt.Errorf("the check keeps its node in %s, which must be writable: %w", filepath.Join(dir, "relay-check"), err)
	}
	// Its own lock file: the store's lock guards single writes and is taken inside EnsureIdentity.
	hold, err := state.OpenDir(filepath.Join(dir, "relay-check", "hold"))
	if err != nil {
		return nil, nil, err
	}
	type locked struct {
		release func()
		err     error
	}
	got := make(chan locked, 1)
	go func() {
		release, err := hold.Lock()
		got <- locked{release, err}
	}()
	var l locked
	select {
	case l = <-got:
	case <-ctx.Done():
		// Release the lock if it still arrives, so the waiting goroutine does not keep it.
		go func() {
			if l := <-got; l.err == nil {
				l.release()
			}
		}()
		return nil, nil, errors.New("another pen relay check on this machine held the check node until --timeout")
	}
	if l.err != nil {
		return nil, nil, l.err
	}
	id, _, err := st.EnsureIdentity()
	if err != nil {
		l.release()
		return nil, nil, err
	}
	return id, l.release, nil
}

// checkRoundTrip uplinks the check node, opens a client session to it and moves 64 KiB each way.
func checkRoundTrip(ctx context.Context, relayURL string, stdout io.Writer) error {
	id, release, err := checkIdentity(ctx)
	if err != nil {
		return err
	}
	defer release()
	up := relay.NewUplink(relayURL, id)
	ready := make(chan struct{})
	var once sync.Once
	up.OnState = func(on bool) {
		if on {
			once.Do(func() { close(ready) })
		}
	}
	uctx, stop := context.WithCancel(ctx)
	defer stop()
	start := time.Now()
	go up.Run(uctx)
	select {
	case <-ready:
	case <-ctx.Done():
		return errors.New("the check node could not authenticate its uplink in time")
	}
	uplinked := time.Since(start)

	start = time.Now()
	// Sends on a relay socket are not bound by a context, so the session runs aside and --timeout
	// still ends the check when a relay stops reading.
	done := make(chan error, 1)
	go func() { done <- checkSession(ctx, relayURL, id, up) }()
	select {
	case err := <-done:
		if err != nil {
			return err
		}
	case <-ctx.Done():
		return errors.New("the relay stopped moving data before --timeout")
	}
	fmt.Fprintf(stdout, "ok: the check node uplinked in %d ms; 64 KiB each way through the relay in %d ms\n",
		uplinked.Milliseconds(), time.Since(start).Milliseconds())
	return nil
}

// checkSession opens a client session to the check node and moves 64 KiB each way. The relay
// confirms nothing when an uplink authenticates (the Worker answers ping before it handles the
// answer), so until it has taken this uplink a client reaches the uplink it replaces, which closes
// the session 4404 once replaced, or no uplink (4404). A session that ends before the node side has
// answered is opened again, within --timeout.
func checkSession(ctx context.Context, relayURL string, id *ident.Identity, up *relay.Uplink) error {
	for attempt := 1; ; attempt++ {
		node, client, err := openCheckSession(ctx, relayURL, id, up, attempt)
		if err == nil {
			defer client.Close(wire.CodeNormal)
			defer node.Close(wire.CodeNormal)
			if err := exchange(ctx, client, node); err != nil {
				return fmt.Errorf("client to node: %w", err)
			}
			if err := exchange(ctx, node, client); err != nil {
				return fmt.Errorf("node to client: %w", err)
			}
			return nil
		}
		if relay.CodeOf(err) == 0 || ctx.Err() != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return err
		case <-time.After(min(time.Duration(attempt)*100*time.Millisecond, time.Second)):
		}
	}
}

// openCheckSession dials the check node as a client and waits for the node side to accept this
// attempt's session and answer it.
func openCheckSession(ctx context.Context, relayURL string, id *ident.Identity, up *relay.Uplink, attempt int) (node, client relay.Conn, err error) {
	client, err = relay.Dial(ctx, relayURL, id.NodeID())
	if err != nil {
		return nil, nil, fmt.Errorf("client dial: %w", err)
	}
	hello := fmt.Sprintf("pen relay check %d", attempt)
	if err := client.Send([]byte(hello)); err != nil {
		client.Close(wire.CodeNormal)
		return nil, nil, fmt.Errorf("client send: %w", err)
	}
	actx, cancel := context.WithCancel(ctx)
	defer cancel()
	accepted := make(chan relay.Conn, 1)
	go func() {
		for {
			n, err := up.Accept(actx)
			if err != nil {
				close(accepted)
				return
			}
			// A session of an earlier attempt can still arrive; only this attempt's counts.
			if got, err := n.Recv(actx); err == nil && string(got) == hello && n.Send([]byte("ready")) == nil {
				accepted <- n
				return
			}
			n.Close(wire.CodeNormal)
		}
	}()
	got, err := client.Recv(ctx)
	if err == nil && string(got) != "ready" {
		err = fmt.Errorf("the client got %q instead of the node's answer", got)
	}
	if err != nil {
		client.Close(wire.CodeNormal)
		cancel()
		if n, ok := <-accepted; ok {
			n.Close(wire.CodeNormal)
		}
		return nil, nil, fmt.Errorf("client: %w", err)
	}
	return <-accepted, client, nil
}

// exchange sends checkChunks random messages from one end and reads them back at the other.
func exchange(ctx context.Context, from, to relay.Conn) error {
	sent := make([][]byte, checkChunks)
	for i := range sent {
		sent[i] = make([]byte, checkChunk)
		rand.Read(sent[i])
		if err := from.Send(sent[i]); err != nil {
			return err
		}
	}
	for i := range sent {
		got, err := to.Recv(ctx)
		if err != nil {
			return err
		}
		if !bytes.Equal(got, sent[i]) {
			return fmt.Errorf("message %d arrived changed", i)
		}
	}
	return nil
}
