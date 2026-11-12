package cli

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"github.com/goat-si/goat/apps/pen/internal/state"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"slices"
	"strings"
	"syscall"
	"time"

	"golang.org/x/crypto/acme/autocert"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relayserver"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// RunRelay dispatches pen relay serve|add|rm|ls|download.
func RunRelay(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "usage: pen relay serve|add|rm|ls|download|check")
		return 2
	}
	switch args[0] {
	case "serve":
		return runRelayServe(args[1:], stdout, stderr)
	case "check":
		return runRelayCheck(args[1:], stdout, stderr)
	case "add", "rm":
		return runRelayEdit(args[0], args[1:], stdout, stderr)
	case "ls":
		return runRelayLs(stdout, stderr)
	case "download":
		return runRelayDownload(args[1:], stdout, stderr)
	}
	fmt.Fprintf(stderr, "pen relay: unknown command %q\n", args[0])
	return 2
}

var afterRelayConfigRead func()

func runRelayEdit(verb string, args []string, stdout, stderr io.Writer) int {
	if len(args) != 1 {
		fmt.Fprintf(stderr, "usage: pen relay %s <url>\n", verb)
		return 2
	}
	u := strings.TrimRight(args[0], "/")
	st, err := openState()
	if err != nil {
		return fail(stderr, err)
	}
	cfg, err := st.LoadConfig()
	if err != nil {
		return fail(stderr, err)
	}
	if afterRelayConfigRead != nil {
		afterRelayConfigRead()
	}
	edit := func(c state.Config) (list []string, already bool, err error) {
		list = slices.Clone(c.RelayList())
		if verb == "add" {
			if slices.Contains(list, u) {
				return list, true, nil
			}
			list = append(list, u)
		} else {
			if !slices.Contains(list, u) {
				return nil, false, fmt.Errorf("%s is not one of this node's relays", u)
			}
			if len(list) == 1 {
				return nil, false, errors.New("a node needs at least one relay; add another first")
			}
			list = slices.DeleteFunc(list, func(x string) bool { return x == u })
		}
		return list, false, daemon.ValidRelays(list)
	}
	var list []string
	var already bool
	var editErr error
	cl, err := daemon.Dial(st)
	switch {
	case errors.Is(err, daemon.ErrNotRunning):
		// Under the state lock, as UpdateConfig, but an edit that changes nothing writes nothing. The
		// lock is released before anything is printed: blocked output must not hold other writers.
		err := func() error {
			unlock, err := st.Lock()
			if err != nil {
				return err
			}
			defer unlock()
			c, err := st.LoadConfig()
			if err != nil {
				return err
			}
			if list, already, editErr = edit(c); editErr == nil && !already {
				c.SetRelays(list)
				return st.SaveConfig(c)
			}
			return nil
		}()
		if err != nil {
			return fail(stderr, err)
		}
	case err != nil:
		return fail(stderr, err)
	default:
		defer cl.Close()
		list, already, editErr = edit(cfg)
		if editErr == nil && !already {
			var s daemon.Status
			if err := cl.Send(daemon.Request{Op: "relays", Relays: list}); err != nil {
				return fail(stderr, err)
			}
			if err := cl.Next(&s); err != nil {
				return fail(stderr, err)
			}
			fmt.Fprintln(stdout, "the running node now uses:")
		}
	}
	if editErr != nil {
		return fail(stderr, editErr)
	}
	if already {
		fmt.Fprintf(stdout, "%s is already a relay\n", u)
		return 0
	}
	for _, r := range list {
		fmt.Fprintln(stdout, r)
	}
	return 0
}

func runRelayLs(stdout, stderr io.Writer) int {
	st, err := openState()
	if err != nil {
		return fail(stderr, err)
	}
	var s daemon.Status
	if err := daemon.Call(st, daemon.Request{Op: "status"}, &s); err == nil {
		for _, r := range s.Relays {
			fmt.Fprintf(stdout, "%s\tuplink %s\n", r.URL, r.Uplink)
		}
		return 0
	}
	cfg, err := st.LoadConfig()
	if err != nil {
		return fail(stderr, err)
	}
	for _, r := range cfg.RelayList() {
		fmt.Fprintf(stdout, "%s\tdaemon not running\n", r)
	}
	return 0
}

// serveConfig is pen relay serve's validated flags.
type serveConfig struct {
	listen       string
	autocertHost string
	cacheDir     string
	certFile     string
	keyFile      string
	plain        bool
	publicOrigin string
	maxSockets   int
	maxPerIP     int
	maxUnauth    int
	maxQueuedMiB int
	maxShareMiB  int
	// readTimeout and limits override the defaults in tests.
	readTimeout time.Duration
	limits      *relayserver.Limits
	// trafficLog receives the relay's session and totals lines (stderr, so the service journal).
	trafficLog io.Writer
	// trafficNodes are the node ids that get totals and session lines.
	trafficNodes map[string]bool
}

func parseServe(args []string, stderr io.Writer) (serveConfig, error) {
	var c serveConfig
	var trafficNodes string
	fs := flag.NewFlagSet("pen relay serve", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.StringVar(&c.listen, "listen", ":443", "address to listen on")
	fs.StringVar(&c.autocertHost, "autocert", "", "get a certificate for this host from Let's Encrypt (TLS-ALPN-01 on :443)")
	fs.StringVar(&c.cacheDir, "cache", "", "autocert certificate cache directory")
	fs.StringVar(&c.certFile, "cert", "", "TLS certificate file")
	fs.StringVar(&c.keyFile, "key", "", "TLS key file")
	fs.BoolVar(&c.plain, "plain", false, "serve without TLS (tests, or behind a TLS terminator)")
	fs.StringVar(&c.publicOrigin, "public-origin", "", "origin uplinks sign, e.g. wss://relay.example (behind a TLS terminator)")
	fs.IntVar(&c.maxSockets, "max-sockets", relayserver.DefaultMaxSockets, "most sockets the relay holds at once")
	fs.IntVar(&c.maxPerIP, "max-per-ip", relayserver.DefaultMaxPerIP, "most sockets from one IPv4 address or IPv6 /64")
	fs.IntVar(&c.maxUnauth, "max-unauth-per-node", relayserver.DefaultMaxUnauthPerNode, "most unauthenticated uplinks per node id (a newer one evicts the oldest)")
	fs.IntVar(&c.maxQueuedMiB, "max-queued-mib", relayserver.DefaultMaxQueued>>20, "most MiB all sockets' queued and partly read messages hold together; data past it ends its session 4408")
	fs.IntVar(&c.maxShareMiB, "max-queued-per-source-mib", relayserver.DefaultMaxQueuedPerSource>>20, "most of --max-queued-mib one IPv4 address's or IPv6 /64's sockets hold; data past it ends the session that holds it 4408")
	fs.StringVar(&trafficNodes, "traffic-nodes", "", "comma-separated node ids that get byte totals and session lines on stderr (relay-wide totals need none)")
	if err := fs.Parse(args); err != nil {
		return c, err
	}
	if fs.NArg() != 0 {
		return c, fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	nodes, err := parseTrafficNodes(trafficNodes)
	if err != nil {
		return c, err
	}
	c.trafficNodes = nodes
	if c.maxSockets < 1 || c.maxPerIP < 1 || c.maxUnauth < 1 || c.maxQueuedMiB < 1 || c.maxShareMiB < 1 {
		return c, errors.New("--max-sockets, --max-per-ip, --max-unauth-per-node, --max-queued-mib and --max-queued-per-source-mib must be at least 1")
	}
	modes := 0
	for _, on := range []bool{c.autocertHost != "", c.certFile != "" || c.keyFile != "", c.plain} {
		if on {
			modes++
		}
	}
	if modes != 1 {
		return c, errors.New("choose exactly one of --autocert <host>, --cert/--key or --plain")
	}
	if c.autocertHost != "" {
		if c.cacheDir == "" {
			return c, errors.New("--autocert needs --cache <dir> to keep the certificate")
		}
		if strings.ContainsAny(c.autocertHost, ":/") || net.ParseIP(c.autocertHost) != nil || !strings.Contains(c.autocertHost, ".") {
			return c, fmt.Errorf("--autocert wants a DNS name such as 203-0-113-7.sslip.io, not %q", c.autocertHost)
		}
		// TLS-ALPN-01 validates on port 443 only.
		if _, port, err := net.SplitHostPort(c.listen); err != nil || port != "443" {
			return c, errors.New("--autocert needs --listen on port 443 (TLS-ALPN-01)")
		}
		origin := "wss://" + strings.ToLower(c.autocertHost)
		if c.publicOrigin != "" && c.publicOrigin != origin {
			return c, fmt.Errorf("--autocert %s serves %s; --public-origin %s differs", c.autocertHost, origin, c.publicOrigin)
		}
		c.publicOrigin = origin
	} else if c.cacheDir != "" {
		return c, errors.New("--cache is only for --autocert")
	}
	if (c.certFile == "") != (c.keyFile == "") {
		return c, errors.New("--cert and --key go together")
	}
	if c.publicOrigin != "" {
		o, err := wire.RelayOrigin(c.publicOrigin)
		if err != nil || o != c.publicOrigin {
			return c, fmt.Errorf("--public-origin must be ws://host or wss://host[:port] exactly, got %q", c.publicOrigin)
		}
	}
	if c.certFile != "" && c.publicOrigin == "" {
		return c, errors.New("--cert needs --public-origin wss://<host the certificate names>")
	}
	if c.plain && c.publicOrigin == "" {
		host, _, err := net.SplitHostPort(c.listen)
		if err != nil || !loopbackHost(host) {
			return c, errors.New("--plain without --public-origin listens on loopback only (e.g. --listen 127.0.0.1:8080)")
		}
	}
	return c, nil
}

// prepareCache makes the autocert cache a 0700 directory: it holds the TLS private key.
func prepareCache(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	fi, err := os.Stat(dir)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return fmt.Errorf("--cache %s is not a directory", dir)
	}
	if private, err := state.OwnerOnly(dir); err != nil || !private {
		if err := state.RestrictDir(dir); err != nil {
			return fmt.Errorf("--cache %s is open to other users and cannot be made private: %w", dir, err)
		}
	}
	return nil
}

// autocertManager issues certificates for exactly one host.
func autocertManager(c serveConfig) *autocert.Manager {
	return &autocert.Manager{
		Prompt:     autocert.AcceptTOS,
		HostPolicy: autocert.HostWhitelist(c.autocertHost),
		Cache:      autocert.DirCache(c.cacheDir),
	}
}

// serve runs the relay until ctx ends; ready gets the bound address.
func serve(ctx context.Context, c serveConfig, ready func(addr string), hooks relayserver.Hooks) error {
	ln, err := net.Listen("tcp", c.listen)
	if err != nil {
		return err
	}
	return serveOn(ctx, c, ln, ready, hooks)
}

// serveOn runs the relay on ln.
func serveOn(ctx context.Context, c serveConfig, ln net.Listener, ready func(addr string), hooks relayserver.Hooks) error {
	limits := relayserver.DefaultLimits()
	if c.limits != nil {
		limits = *c.limits
	}
	rs := relayserver.New(limits)
	rs.PublicOrigin = c.publicOrigin
	rs.MaxSockets, rs.MaxPerIP, rs.MaxUnauthPerNode = c.maxSockets, c.maxPerIP, c.maxUnauth
	rs.MaxQueued = c.maxQueuedMiB << 20
	rs.MaxQueuedPerSource = c.maxShareMiB << 20
	rs.TrafficLog = c.trafficLog
	rs.TrafficNodes = c.trafficNodes
	rs.Hooks = hooks
	readTimeout := 30 * time.Second
	if c.readTimeout > 0 {
		readTimeout = c.readTimeout
	}
	// The timeouts bound plain requests; the relay clears them on a socket it upgrades.
	srv := &http.Server{Handler: rs, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: readTimeout,
		WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: relayserver.MaxHeaderBytes}
	ln = rs.Listen(ln)
	switch {
	case c.autocertHost != "":
		if err := prepareCache(c.cacheDir); err != nil {
			ln.Close()
			return err
		}
		srv.TLSConfig = autocertManager(c).TLSConfig()
	case c.certFile != "":
		cert, err := tls.LoadX509KeyPair(c.certFile, c.keyFile)
		if err != nil {
			ln.Close()
			return err
		}
		srv.TLSConfig = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	}
	if srv.TLSConfig != nil {
		ln = tls.NewListener(ln, srv.TLSConfig)
	}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		rs.Close()
		srv.Shutdown(sctx)
	}()
	if ready != nil {
		ready(ln.Addr().String())
	}
	if err := srv.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func runRelayServe(args []string, stdout, stderr io.Writer) int {
	c, err := parseServe(args, stderr)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return fail(stderr, err)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	c.trafficLog = stderr
	mode := "tls"
	if c.plain {
		mode = "plain"
	}
	err = serve(ctx, c, func(addr string) {
		fmt.Fprintf(stdout, "pen relay listening on %s (%s)\n", addr, mode)
	}, relayserver.Hooks{})
	if err != nil {
		return fail(stderr, err)
	}
	return 0
}

func loopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// runRelayDownload prints the relay that serves install.sh to this node's invitees, or sets it.
func runRelayDownload(args []string, stdout, stderr io.Writer) int {
	if len(args) > 1 {
		fmt.Fprintln(stderr, "usage: pen relay download [url]")
		return 2
	}
	st, err := openState()
	if err != nil {
		return fail(stderr, err)
	}
	cfg, err := st.LoadConfig()
	if err != nil {
		return fail(stderr, err)
	}
	if len(args) == 0 {
		fmt.Fprintln(stdout, daemon.DownloadRelayOf(cfg))
		return 0
	}
	u := strings.TrimRight(args[0], "/")
	if err := downloadOrigin(u); err != nil {
		return fail(stderr, err)
	}
	if err := st.UpdateConfig(func(c *state.Config) { c.DownloadRelay = u }); err != nil {
		return fail(stderr, err)
	}
	return 0
}

// downloadOrigin accepts an https origin (http only for a loopback host) with no user, path, query
// or fragment: invites print it in front of /install.sh.
func downloadOrigin(u string) error {
	bad := fmt.Errorf("download relay %q: want https://<host>[:port] (http:// only for loopback)", u)
	p, err := url.Parse(u)
	if err != nil || p.Host == "" || p.User != nil || p.Path != "" || p.Opaque != "" || strings.ContainsAny(u, "?#") {
		return bad
	}
	host := p.Hostname()
	ip := net.ParseIP(host)
	if ip == nil && !dnsName(host) {
		return bad
	}
	loopback := strings.EqualFold(host, "localhost") || ip != nil && ip.IsLoopback()
	if p.Scheme != "https" && (p.Scheme != "http" || !loopback) {
		return bad
	}
	return nil
}

// dnsName reports a host made only of letters, digits, dots and hyphens, so it carries no shell syntax.
func dnsName(h string) bool {
	if h == "" || len(h) > 253 {
		return false
	}
	for _, c := range h {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '-') {
			return false
		}
	}
	return true
}

// parseTrafficNodes reads --traffic-nodes: full node ids separated by commas, at most
// relayserver.MaxTrafficNodes of them.
func parseTrafficNodes(list string) (map[string]bool, error) {
	nodes := map[string]bool{}
	for _, id := range strings.Split(list, ",") {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if !ident.ValidNodeID(id) {
			return nil, fmt.Errorf("--traffic-nodes wants full node ids (26 characters of a-z and 2-7, as pen ls --json shows), not %q", id)
		}
		nodes[id] = true
	}
	if len(nodes) > relayserver.MaxTrafficNodes {
		return nil, fmt.Errorf("--traffic-nodes lists %d node ids; at most %d", len(nodes), relayserver.MaxTrafficNodes)
	}
	return nodes, nil
}
