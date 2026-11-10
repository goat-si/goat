package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/login"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

const (
	// loginRetry is how often a joiner retries while no member is online or its request is queued.
	loginRetry = 5 * time.Second
	// loginPatience is how long a queued request waits for approval.
	loginPatience = 30 * time.Minute
)

// Seams for tests: how pen login starts the daemon, builds its login client and waits between retries.
var (
	startDaemon = func(st *state.Store, noService bool, stderr io.Writer) error {
		args := []string{}
		if noService {
			args = append(args, "--no-service")
		}
		if code := RunUp(args, io.Discard, stderr); code != 0 {
			return errors.New("pen up failed")
		}
		return nil
	}
	newLoginClient = login.New
	retryAfter     = time.After
	nowFn          = time.Now
)

// loginState is login.json: the account this node last signed in with.
type loginState struct {
	LoginURL string `json:"loginUrl"`
	Sub      string `json:"sub"`
	Email    string `json:"email"`
	MeshID   string `json:"meshId"`
}

const loginFile = "login.json"

func defaultLoginURL() string {
	if u := os.Getenv("PEN_LOGIN"); u != "" {
		return u
	}
	return login.DefaultURL
}

// confirm asks a yes/no question on Stdin; --yes answers for scripts.
func confirm(stdout io.Writer, yes bool, question string) bool {
	fmt.Fprintf(stdout, "%s [y/N] ", question)
	if yes {
		fmt.Fprintln(stdout, "yes (--yes)")
		return true
	}
	line, _ := bufio.NewReader(Stdin).ReadString('\n')
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes":
		return true
	}
	return false
}

// RunLogin signs this machine in with Google through the login service, then founds and binds a
// mesh, or joins the account's mesh (contract "Accounts").
func RunLogin(args []string, stdout, stderr io.Writer) int {
	fs := newFlags("login", stderr)
	loginURL := fs.String("login-url", defaultLoginURL(), "login service URL")
	var relayURLs multiFlag
	fs.Var(&relayURLs, "relay", "relay URL (https://...); repeat for several relays")
	name := fs.String("name", "", "this node's name")
	noService := fs.Bool("no-service", false, "never install a systemd or launchd service")
	yes := fs.Bool("yes", false, "found or join without asking (for scripts)")
	if _, err := parse(fs, args); err != nil {
		return 2
	}
	st, err := openState()
	if err != nil {
		return fail(stderr, err)
	}
	if err := clearLeft(st); err != nil {
		return fail(stderr, err)
	}
	id, _, err := st.EnsureIdentity()
	if err != nil {
		return fail(stderr, err)
	}
	cfg, err := st.LoadConfig()
	if err != nil {
		return fail(stderr, err)
	}
	if len(relayURLs) > 0 {
		var list []string
		for _, u := range relayURLs {
			list = append(list, strings.TrimRight(u, "/"))
		}
		if err := daemon.ValidRelays(list); err != nil {
			return fail(stderr, err)
		}
		cfg.SetRelays(list)
	}
	if len(cfg.RelayList()) == 0 {
		return fail(stderr, errors.New("no relay configured; pass --relay https://<relay>"))
	}
	if *name != "" {
		cfg.Name = *name
	}
	if cfg.Name == "" {
		cfg.Name = defaultName()
	}
	if !ident.ValidName(cfg.Name) {
		return fail(stderr, fmt.Errorf("invalid name %q", cfg.Name))
	}
	if err := st.SaveConfig(cfg); err != nil {
		return fail(stderr, err)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	l := &loginRun{st: st, id: id, name: cfg.Name, relays: cfg.RelayList(), noService: *noService, yes: *yes,
		lc: newLoginClient(*loginURL), stdout: stdout, stderr: stderr}
	if err := l.run(ctx); err != nil {
		return fail(stderr, err)
	}
	return 0
}

type loginRun struct {
	st        *state.Store
	id        *ident.Identity
	name      string
	relays    []string
	noService bool
	yes       bool
	lc        *login.Client
	stdout    io.Writer
	stderr    io.Writer
	tok       *login.Token
	signedIn  time.Time
}

func (l *loginRun) run(ctx context.Context) error {
	s, err := l.lc.Start(ctx, l.id, l.name)
	if err != nil {
		return fmt.Errorf("could not start a sign-in at %s (%w); check --login-url, or try again later if the service is down", l.lc.URL, err)
	}
	fmt.Fprintf(l.stdout, "To sign in, open %s and type the code %s\n", s.VerificationURI, s.UserCode)
	fmt.Fprintf(l.stdout, "  this machine: %s, fingerprint %s\n  waiting for the sign-in...\n", l.name, ident.Fingerprint(l.id.NoisePub))
	tok, err := l.lc.Wait(ctx, l.id, s)
	if err != nil {
		return err
	}
	l.tok, l.signedIn = tok, time.Now()
	fmt.Fprintf(l.stdout, "signed in as %s\n", safe(tok.Account.Email))
	cur, err := mesh.Load(l.st)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if tok.Mesh == nil || tok.Mesh.MeshID == "" {
		return l.foundAndBind(ctx, cur)
	}
	if cur != nil && cur.MeshID == tok.Mesh.MeshID {
		if _, ok := cur.View().Members[ident.B64.EncodeToString(l.id.SignPub)]; ok {
			fmt.Fprintf(l.stdout, "this machine is already a member of mesh %s\n", cur.MeshID)
			if err := startDaemon(l.st, l.noService, l.stderr); err != nil {
				return err
			}
			if err := l.bindAgain(ctx, cur.MeshID); err != nil {
				return err
			}
			return l.register(ctx, cur.MeshID)
		}
	}
	if cur != nil && len(cur.View().Members) > 1 {
		return fmt.Errorf("this machine is in mesh %s with %d members, and %s is registered with mesh %s; pen leave first",
			cur.MeshID, len(cur.View().Members), safe(tok.Account.Email), tok.Mesh.MeshID)
	}
	return l.join(ctx)
}

// account is the binding this sign-in vouches for.
func (l *loginRun) account() mesh.Account {
	return mesh.Account{LoginURL: l.lc.URL, LoginKey: mesh.LoginKey(l.tok.LoginKey), Sub: l.tok.Account.Sub}
}

// bindAgain offers to bind a member's mesh again when it is unbound, bound to an older login key or
// bound to another account (contract "Account join": the way back after an unbind or a rotation).
func (l *loginRun) bindAgain(ctx context.Context, meshID string) error {
	var ls daemon.LsReply
	if err := daemon.Call(l.st, daemon.Request{Op: "ls"}, &ls); err != nil {
		return err
	}
	want := l.account()
	if ls.Account != nil && *ls.Account == want {
		return nil
	}
	if !confirm(l.stdout, l.yes, bindAgainQuestion(meshID, ls.Account, want, l.tok.Account.Email)) {
		fmt.Fprintln(l.stdout, "the mesh's binding is unchanged")
		return nil
	}
	acct := want
	var r map[string]any
	if err := daemon.Call(l.st, daemon.Request{Op: "login-bind", Account: &acct}, &r); err != nil {
		return err
	}
	fmt.Fprintf(l.stdout, "mesh %s is bound to %s again\n", meshID, safe(l.tok.Account.Email))
	return nil
}

// bindAgainQuestion asks to bind a mesh bound to cur (nil: unbound) to want instead.
func bindAgainQuestion(meshID string, cur *mesh.Account, want mesh.Account, email string) string {
	switch {
	case cur == nil:
		return fmt.Sprintf("Mesh %s is not bound to a Google account. Bind it to %s again?", meshID, safe(email))
	case cur.Sub == want.Sub:
		return fmt.Sprintf("Mesh %s is bound to an older login key (%s). Bind it to the service's current key %s?", meshID, cur.LoginKey.Kid, want.LoginKey.Kid)
	}
	return fmt.Sprintf("Mesh %s is bound to another Google account (sub %s). Bind it to %s instead?", meshID, safe(cur.Sub), safe(email))
}

func otherAccountWarning(meshID, sub string) string {
	return fmt.Sprintf("warning: mesh %s is bound to another Google account (sub %s); binding replaces it", meshID, safe(sub))
}

// foundAndBind binds this node's mesh (founding one if there is none) to the account.
func (l *loginRun) foundAndBind(ctx context.Context, cur *mesh.Store) error {
	q := fmt.Sprintf("No mesh is registered for %s. Found a mesh with this machine and bind it to %s?", safe(l.tok.Account.Email), safe(l.tok.Account.Email))
	if cur != nil {
		v := cur.View()
		if n := len(v.Members); n > 1 {
			fmt.Fprintf(l.stdout, "warning: mesh %s has %d other members; binding it lets every machine that signs in as %s join them\n", cur.MeshID, n-1, safe(l.tok.Account.Email))
			q = fmt.Sprintf("No mesh is registered for %s. Bind this machine's mesh %s (%d members) to %s?", safe(l.tok.Account.Email), cur.MeshID, n, safe(l.tok.Account.Email))
		}
		if v.Account != nil && v.Account.Sub != l.tok.Account.Sub {
			fmt.Fprintln(l.stdout, otherAccountWarning(cur.MeshID, v.Account.Sub))
		}
	}
	if !confirm(l.stdout, l.yes, q) {
		return errors.New("nothing changed")
	}
	if cur == nil {
		if _, err := mesh.Found(l.st, l.id, l.name, time.Now().UnixMilli()); err != nil {
			return err
		}
	}
	if err := startDaemon(l.st, l.noService, l.stderr); err != nil {
		return err
	}
	acct := l.account()
	var r struct {
		Status daemon.Status `json:"status"`
	}
	if err := daemon.Call(l.st, daemon.Request{Op: "login-bind", Account: &acct}, &r); err != nil {
		return err
	}
	if err := l.register(ctx, r.Status.MeshID); err != nil {
		return err
	}
	fmt.Fprintf(l.stdout, "mesh %s is bound to %s; other machines join it with pen login\n", r.Status.MeshID, safe(l.tok.Account.Email))
	return nil
}

func (l *loginRun) register(ctx context.Context, meshID string) error {
	if err := l.lc.Register(ctx, l.id, l.tok.Assertion, meshID); err != nil {
		if errors.Is(err, login.ErrOtherMesh) {
			return fmt.Errorf("%w meanwhile; run pen login again", err)
		}
		// The same node signing in again within a second gets a byte-identical assertion, which
		// already registered it.
		if !errors.Is(err, login.ErrAssertionUsed) {
			return err
		}
	}
	return l.saveLogin(meshID)
}

func (l *loginRun) saveLogin(meshID string) error {
	return l.st.WriteJSON(loginFile, loginState{LoginURL: l.lc.URL, Sub: l.tok.Account.Sub, Email: l.tok.Account.Email, MeshID: meshID}, 0o600)
}

// join asks, joins the offered mesh through the first member to answer, syncs and starts the node.
func (l *loginRun) join(ctx context.Context) error {
	offer := l.tok.Mesh
	fmt.Fprintf(l.stdout, "%s is registered with mesh %s:\n", safe(l.tok.Account.Email), offer.MeshID)
	for _, m := range offer.Members {
		fmt.Fprintf(l.stdout, "  %-20s %s\n", m.Name, fingerprintOf(m.NoisePub))
	}
	if len(offer.Members) == 0 {
		return l.noMembers(offer.MeshID, "lists no machines (every one logged out)")
	}
	if !confirm(l.stdout, l.yes, fmt.Sprintf("Join it as %s? Every machine in it gets full access to this one, and this one to them.", l.name)) {
		return errors.New("nothing changed")
	}
	s, err := l.joinLoop(ctx, offer)
	if err != nil {
		return err
	}
	self := ident.B64.EncodeToString(l.id.SignPub)
	taken, others, err := daemon.FinishJoin(ctx, l.relays, l.id, s, l.tok.Mesh.Members, l.tok.Assertion)
	if err != nil {
		return err
	}
	if taken < 2 {
		fmt.Fprintf(l.stderr, "pen: warning: only %d of %d other members were reachable to sync with; this machine trusts what they told it\n", taken, others)
	}
	if err := l.install(s); err != nil {
		return err
	}
	// A slow approval can outlive the assertion: this node is a member, but the registry takes only a
	// live assertion, so the next pen login registers it. Clocks may differ by the contract's 60 s.
	expired := !nowFn().Before(time.Unix(l.tok.Assertion.A.Exp, 0).Add(login.Skew))
	if !expired {
		err := l.register(ctx, s.MeshID)
		var h *login.HTTPError
		if errors.As(err, &h) && strings.Contains(h.Body, "expired") {
			expired = true
		} else if err != nil {
			return err
		}
	}
	if expired {
		if err := l.saveLogin(s.MeshID); err != nil {
			return err
		}
		fmt.Fprintf(l.stdout, "the sign-in expired before the approval, so registration waits for the next pen login\n")
	}
	v := s.View()
	fmt.Fprintf(l.stdout, "member of mesh %s as %s (%d members), %d ms after sign-in\n", s.MeshID, v.Members[self].Name,
		len(v.Members), time.Since(l.signedIn).Milliseconds())
	return nil
}

// joinLoop runs the account join, retrying every 5 s while no member is online, and waits up to
// 30 minutes for a member's approval when the mesh is locked.
func (l *loginRun) joinLoop(ctx context.Context, offer *login.OfferedMesh) (*mesh.Store, error) {
	said := false
	for {
		out, by, err := daemon.AccountJoin(ctx, l.relays, l.id, l.name, l.tok.Assertion, offer.Members)
		var refused *mesh.RefusedError
		switch {
		case errors.Is(err, daemon.ErrNoMemberOnline):
			if time.Now().After(time.Unix(l.tok.Assertion.A.Exp, 0)) {
				return nil, l.noMembers(offer.MeshID, "had no machine online before the sign-in expired")
			}
			if !said {
				fmt.Fprintln(l.stdout, "no member online yet, retrying every 5 s")
				said = true
			}
		case errors.As(err, &refused) && refused.Reason == "already a member":
			for _, m := range offer.Members {
				if s, err := daemon.SyncApproved(ctx, l.relays, l.id, m, offer.MeshID); err == nil {
					return s, nil
				}
			}
			return nil, err
		case err != nil:
			return nil, err
		case out.MeshID != offer.MeshID:
			return nil, fmt.Errorf("member %s offered mesh %s, but the account is registered with %s", by.Name, out.MeshID, offer.MeshID)
		case out.QueuedID != "":
			return l.waitApproval(ctx, out, by)
		default:
			return mesh.CheckJoined(nil, l.id, out.MeshID, out.Records)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-retryAfter(loginRetry):
		}
	}
}

func (l *loginRun) waitApproval(ctx context.Context, out mesh.AccountOutcome, by login.OfferedMember) (*mesh.Store, error) {
	fmt.Fprintf(l.stdout, "the mesh is locked: request %s is queued on %s\n  this machine's fingerprint: %s\n  on %s run: pen approve '%s'\n",
		out.QueuedID, out.QueuedBy, ident.Fingerprint(l.id.NoisePub), out.QueuedBy, ident.Fingerprint(l.id.NoisePub))
	deadline := time.Now().Add(loginPatience)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-retryAfter(loginRetry):
		}
		s, err := daemon.SyncApproved(ctx, l.relays, l.id, by, out.MeshID)
		if err == nil {
			return s, nil
		}
		if !errors.Is(err, daemon.ErrNotApproved) {
			fmt.Fprintf(l.stderr, "pen: %s: %v; retrying\n", by.Name, err)
		}
	}
	return nil, errors.New("no member approved this machine within 30 minutes; run pen login again")
}

// install saves the joined set: a running daemon adopts it, otherwise it becomes mesh.json and the
// node starts.
func (l *loginRun) install(s *mesh.Store) error {
	var ls daemon.LsReply
	var status daemon.Status
	if err := daemon.Call(l.st, daemon.Request{Op: "status"}, &status); err == nil {
		if err := s.SaveFile(l.st, daemon.JoinedFile); err != nil {
			return err
		}
		return daemon.Call(l.st, daemon.Request{Op: "adopt"}, &ls)
	} else if !errors.Is(err, daemon.ErrNotRunning) {
		return err
	}
	if err := s.SaveFile(l.st, "mesh.json"); err != nil {
		return err
	}
	os.Remove(l.st.Path("offers.json"))
	return startDaemon(l.st, l.noService, l.stderr)
}

// RunLogout forgets this node at the login service and drops the local login state; the node stays
// in its mesh (pen leave leaves it).
func RunLogout(args []string, stdout, stderr io.Writer) int {
	if _, err := parse(newFlags("logout", stderr), args); err != nil {
		return 2
	}
	st, err := openState()
	if err != nil {
		return fail(stderr, err)
	}
	var ls loginState
	ok, err := st.ReadJSON(loginFile, &ls)
	if err != nil {
		return fail(stderr, err)
	}
	if !ok {
		fmt.Fprintln(stdout, "not signed in")
		return 0
	}
	id, err := st.LoadIdentity()
	if err != nil {
		return fail(stderr, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := newLoginClient(ls.LoginURL).Forget(ctx, id, id.NodeID(), time.Now()); err != nil {
		return fail(stderr, fmt.Errorf("the login service did not forget this node: %w", err))
	}
	if err := os.Remove(st.Path(loginFile)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fail(stderr, err)
	}
	fmt.Fprintf(stdout, "signed out of %s; this node stays in mesh %s (pen leave leaves it)\n", safe(ls.Email), ls.MeshID)
	return 0
}

// noMembers explains the ways on when the account's mesh has no machine to join through: the
// registry keeps one mesh per account, so founding another needs the account reset first.
func (l *loginRun) noMembers(meshID, why string) error {
	return fmt.Errorf("mesh %s %s. Run pen login on one of its machines to list it again and retry here, "+
		"or reset the account at %s/device (after a Google sign-in) and run pen login here to found a new mesh", meshID, why, l.lc.URL)
}
