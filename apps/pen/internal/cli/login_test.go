package cli

import (
	"bufio"
	"context"
	"io"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/login"
	"github.com/goat-si/goat/apps/pen/internal/logintest"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

// loginSeams runs daemons in process, polls without waiting and fires retries from tick.
func loginSeams(t *testing.T, ctx context.Context, rs *relaytest.Server) chan time.Time {
	tick := make(chan time.Time, 1)
	oldStart, oldClient, oldRetry := startDaemon, newLoginClient, retryAfter
	startDaemon = func(st *state.Store, _ bool, _ io.Writer) error {
		var s daemon.Status
		if daemon.Call(st, daemon.Request{Op: "status"}, &s) == nil {
			return nil
		}
		startNode(t, ctx, rs, st)
		return nil
	}
	newLoginClient = func(url string) *login.Client {
		c := login.New(url)
		c.After = func(time.Duration) <-chan time.Time {
			ch := make(chan time.Time, 1)
			ch <- time.Time{}
			return ch
		}
		return c
	}
	retryAfter = func(time.Duration) <-chan time.Time { return tick }
	t.Cleanup(func() { startDaemon, newLoginClient, retryAfter = oldStart, oldClient, oldRetry })
	return tick
}

func memberCount(t *testing.T, st *state.Store) int {
	t.Helper()
	var ls daemon.LsReply
	if err := daemon.Call(st, daemon.Request{Op: "ls"}, &ls); err != nil {
		t.Fatal(err)
	}
	return len(ls.Members)
}

func TestLoginFoundsAndBindsThenAMachineJoinsAndALockedMeshQueuesUntilApproved(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := logintest.New()
	f.MinPoll = 0
	f.AutoApprove = &login.Account{Sub: "1001", Email: "me@example.com"}
	f.Start()
	defer f.Close()
	tick := loginSeams(t, ctx, rs)
	flags := func(name string) []string {
		return []string{"--login-url", f.URL, "--relay", rs.URL, "--name", name, "--yes", "--no-service"}
	}

	a := tmpStore(t)
	t.Setenv("PEN_HOME", a.Dir)
	var out, errOut strings.Builder
	if code := RunLogin(flags("a"), &out, &errOut); code != 0 {
		t.Fatalf("first login: exit %d: %s", code, errOut.String())
	}
	meshID, nodes := f.Registry("1001")
	if meshID == "" || len(nodes) != 1 || !strings.Contains(out.String(), "is bound to me@example.com") {
		t.Fatalf("after the first login: registry %q %v; output:\n%s", meshID, nodes, out.String())
	}

	// b already runs a mesh of its own, so its daemon adopts the joined mesh.
	b := tmpStore(t)
	bid, _, _ := b.EnsureIdentity()
	b.SaveConfig(state.Config{Relay: rs.URL, Name: "b"})
	mesh.Found(b, bid, "b", 1)
	startNode(t, ctx, rs, b)
	t.Setenv("PEN_HOME", b.Dir)
	out.Reset()
	if code := RunLogin(flags("b"), &out, &errOut); code != 0 {
		t.Fatalf("second login: exit %d: %s", code, errOut.String())
	}
	if !regexp.MustCompile("member of mesh " + meshID + " as b \\(2 members\\), [0-9]+ ms after sign-in").MatchString(out.String()) {
		t.Fatalf("second login output:\n%s", out.String())
	}
	if memberCount(t, a) != 2 || memberCount(t, b) != 2 {
		t.Fatal("a and b do not both list 2 members")
	}

	var lr map[string]any
	if err := daemon.Call(a, daemon.Request{Op: "lock", On: true}, &lr); err != nil {
		t.Fatal(err)
	}
	c := tmpStore(t)
	t.Setenv("PEN_HOME", c.Dir)
	pr, pw := io.Pipe()
	done := make(chan int, 1)
	var cErr strings.Builder
	go func() { done <- RunLogin(flags("c"), pw, &cErr); pw.Close() }()
	// The request queues on whichever member won the dial race; approve it there.
	fp, queuedOn := "", ""
	sc := bufio.NewScanner(pr)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if m := regexp.MustCompile(`is queued on (\S+)$`).FindStringSubmatch(line); m != nil {
			queuedOn = m[1]
		}
		if v, ok := strings.CutPrefix(line, "this machine's fingerprint: "); ok {
			fp = v
			break
		}
	}
	if fp == "" {
		t.Fatalf("c was not queued: %s", cErr.String())
	}
	go io.Copy(io.Discard, pr)
	approver := map[string]*state.Store{"a": a, "b": b}[queuedOn]
	if approver == nil {
		t.Fatalf("queued on %q, want a or b", queuedOn)
	}
	t.Setenv("PEN_HOME", approver.Dir)
	out.Reset()
	if code := RunApprove([]string{fp}, &out, &errOut); code != 0 || !strings.Contains(out.String(), "approved c") {
		t.Fatalf("approve: exit %d: %s%s", code, out.String(), errOut.String())
	}
	tick <- time.Time{}
	if code := <-done; code != 0 {
		t.Fatalf("third login: exit %d: %s", code, cErr.String())
	}
	if memberCount(t, a) != 3 || memberCount(t, c) != 3 {
		t.Fatal("a and c do not both list 3 members")
	}
	if _, nodes := f.Registry("1001"); len(nodes) != 3 {
		t.Fatalf("registry lists %d nodes, want 3", len(nodes))
	}
}

// approvedLate runs a third machine's login into a locked mesh and has it approved when the
// machine's clock reads exp + cli and the service's reads exp + service (relative to the assertion's
// expiry). It returns the login's exit code and output, the machine's state and the service.
func approvedLate(t *testing.T, cli, service time.Duration) (int, string, *state.Store, *logintest.Server) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	rs := relaytest.New()
	t.Cleanup(rs.Close)
	f := logintest.New()
	f.MinPoll = 0
	f.AutoApprove = &login.Account{Sub: "1001", Email: "me@example.com"}
	f.Start()
	t.Cleanup(f.Close)
	tick := loginSeams(t, ctx, rs)
	flags := func(name string) []string {
		return []string{"--login-url", f.URL, "--relay", rs.URL, "--name", name, "--yes", "--no-service"}
	}
	a := tmpStore(t)
	t.Setenv("PEN_HOME", a.Dir)
	var out, errOut strings.Builder
	if code := RunLogin(flags("a"), &out, &errOut); code != 0 {
		t.Fatalf("first login: %s", errOut.String())
	}
	var lr map[string]any
	if err := daemon.Call(a, daemon.Request{Op: "lock", On: true}, &lr); err != nil {
		t.Fatal(err)
	}
	c := tmpStore(t)
	t.Setenv("PEN_HOME", c.Dir)
	pr, pw := io.Pipe()
	done := make(chan int, 1)
	var cErr strings.Builder
	issued := time.Now()
	go func() { done <- RunLogin(flags("c"), pw, &cErr); pw.Close() }()
	fp := ""
	sc := bufio.NewScanner(pr)
	for sc.Scan() {
		if v, ok := strings.CutPrefix(strings.TrimSpace(sc.Text()), "this machine's fingerprint: "); ok {
			fp = v
			break
		}
	}
	rest := make(chan string, 1)
	go func() {
		var b strings.Builder
		for sc.Scan() {
			b.WriteString(sc.Text() + "\n")
		}
		rest <- b.String()
	}()
	var ar daemon.ApproveResult
	if err := daemon.Call(a, daemon.Request{Op: "approve", Subject: fp}, &ar); err != nil {
		t.Fatal(err)
	}
	exp := issued.Add(login.AssertionLifetime)
	f.SetNow(func() time.Time { return exp.Add(service) })
	oldNow := nowFn
	nowFn = func() time.Time { return exp.Add(cli) }
	t.Cleanup(func() { nowFn = oldNow })
	tick <- time.Time{}
	code := <-done
	pw.Close()
	return code, <-rest + cErr.String(), c, f
}

func TestASlowApprovalLeavesAMemberWhoseRegistrationWaitsForTheNextLogin(t *testing.T) {
	code, out, c, f := approvedLate(t, time.Hour, time.Hour)
	if code != 0 {
		t.Fatalf("slow-approved login: exit %d: %s", code, out)
	}
	if memberCount(t, c) != 2 {
		t.Fatal("c is not a member")
	}
	if !strings.Contains(out, "registration waits for the next pen login") {
		t.Fatalf("output:\n%s", out)
	}
	var ls loginState
	if ok, _ := c.ReadJSON(loginFile, &ls); !ok || ls.Email != "me@example.com" {
		t.Fatalf("login.json %+v (%v)", ls, ok)
	}
	if _, nodes := f.Registry("1001"); len(nodes) != 1 {
		t.Fatalf("registry lists %d nodes, want only a", len(nodes))
	}
}

func TestAnApprovalWithinTheClockSkewAllowanceStillRegisters(t *testing.T) {
	// This machine's clock runs 30 s past the assertion's expiry; the service's has not reached it.
	code, out, c, f := approvedLate(t, 30*time.Second, -10*time.Second)
	if code != 0 || memberCount(t, c) != 2 {
		t.Fatalf("exit %d: %s", code, out)
	}
	if _, nodes := f.Registry("1001"); len(nodes) != 2 {
		t.Fatalf("registry lists %d nodes, want a and c; output:\n%s", len(nodes), out)
	}
}

func lsOf(t *testing.T, st *state.Store) daemon.LsReply {
	t.Helper()
	var ls daemon.LsReply
	if err := daemon.Call(st, daemon.Request{Op: "ls"}, &ls); err != nil {
		t.Fatal(err)
	}
	return ls
}

func TestLoginOnAMemberBindsAgainAfterAnUnbindOrAKeyRotation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := logintest.New()
	f.MinPoll = 0
	f.AutoApprove = &login.Account{Sub: "1001", Email: "me@example.com"}
	f.Start()
	defer f.Close()
	loginSeams(t, ctx, rs)
	args := []string{"--login-url", f.URL, "--relay", rs.URL, "--name", "a", "--yes", "--no-service"}
	a := tmpStore(t)
	t.Setenv("PEN_HOME", a.Dir)
	var out, errOut strings.Builder
	if code := RunLogin(args, &out, &errOut); code != 0 {
		t.Fatalf("first login: %s", errOut.String())
	}
	if code := RunAccount([]string{"unbind"}, &out, &errOut); code != 0 || lsOf(t, a).Account != nil {
		t.Fatalf("unbind: exit %d %s", code, errOut.String())
	}
	out.Reset()
	if code := RunLogin(args, &out, &errOut); code != 0 {
		t.Fatalf("login after unbind: %s", errOut.String())
	}
	if acct := lsOf(t, a).Account; acct == nil || acct.Sub != "1001" {
		t.Fatalf("after pen login on the unbound member: account %+v; output:\n%s", acct, out.String())
	}
	rotated := f.Rotate()
	out.Reset()
	if code := RunLogin(args, &out, &errOut); code != 0 {
		t.Fatalf("login after rotation: %s", errOut.String())
	}
	if acct := lsOf(t, a).Account; acct == nil || acct.LoginKey.Kid != rotated.Kid {
		t.Fatalf("after a key rotation: account %+v, want key %s", acct, rotated.Kid)
	}
	// pen account names the bound key, so an operator can match it against the service's /v1/keys.
	out.Reset()
	if code := RunAccount(nil, &out, &errOut); code != 0 || !strings.Contains(out.String(), "login key "+rotated.Kid) {
		t.Fatalf("pen account after the rebind: exit %d\n%s", code, out.String())
	}
}

func TestApproveTakesOnlyARequestIDOrAFullFingerprint(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := logintest.New()
	f.MinPoll = 0
	f.AutoApprove = &login.Account{Sub: "1001", Email: "me@example.com"}
	f.Start()
	defer f.Close()
	loginSeams(t, ctx, rs)
	a := tmpStore(t)
	t.Setenv("PEN_HOME", a.Dir)
	var out, errOut strings.Builder
	if code := RunLogin([]string{"--login-url", f.URL, "--relay", rs.URL, "--name", "a", "--yes", "--no-service"}, &out, &errOut); code != 0 {
		t.Fatalf("login: %s", errOut.String())
	}
	var lr map[string]any
	daemon.Call(a, daemon.Request{Op: "lock", On: true}, &lr)
	j, _ := ident.Generate(nil)
	ls := lsOf(t, a)
	var members []login.OfferedMember
	for _, m := range ls.Members {
		members = append(members, login.OfferedMember{NodeID: m.NodeID, SignPub: m.SignPub, NoisePub: m.NoisePub, Name: m.Name})
	}
	as := f.Issue("1001", "me@example.com", j.SignPub, j.NoisePub, time.Now())
	if _, _, err := daemon.AccountJoin(ctx, []string{rs.URL}, j, "j", as, members); err != nil {
		t.Fatal(err)
	}
	fp := ident.Fingerprint(j.NoisePub)
	out.Reset()
	errOut.Reset()
	if code := RunApprove([]string{fp[:6]}, &out, &errOut); code == 0 || strings.Contains(out.String(), "request") || !strings.Contains(errOut.String(), "8 or 40") {
		t.Fatalf("a 5-character prefix: exit %d\n%s%s", code, out.String(), errOut.String())
	}
}

func TestLoginWhenEveryMachineOfTheAccountLoggedOutSaysHowToGoOn(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	f := logintest.New()
	f.MinPoll = 0
	f.AutoApprove = &login.Account{Sub: "1001", Email: "me@example.com"}
	f.Start()
	defer f.Close()
	loginSeams(t, ctx, rs)
	flags := func(name string) []string {
		return []string{"--login-url", f.URL, "--relay", rs.URL, "--name", name, "--yes", "--no-service"}
	}
	a := tmpStore(t)
	t.Setenv("PEN_HOME", a.Dir)
	var out, errOut strings.Builder
	if code := RunLogin(flags("a"), &out, &errOut); code != 0 {
		t.Fatalf("login: %s", errOut.String())
	}
	if code := RunLogout(nil, &out, &errOut); code != 0 {
		t.Fatalf("logout: %s", errOut.String())
	}
	b := tmpStore(t)
	t.Setenv("PEN_HOME", b.Dir)
	out.Reset()
	errOut.Reset()
	if code := RunLogin(flags("b"), &out, &errOut); code == 0 || !strings.Contains(errOut.String(), "reset") {
		t.Fatalf("login with every machine logged out: exit %d\n%s%s", code, out.String(), errOut.String())
	}
}

func TestAnApprovalTheServiceFindsExpiredStillLeavesAMember(t *testing.T) {
	code, out, c, f := approvedLate(t, 30*time.Second, 30*time.Second)
	if code != 0 || memberCount(t, c) != 2 || !strings.Contains(out, "registration waits for the next pen login") {
		t.Fatalf("exit %d: %s", code, out)
	}
	if _, nodes := f.Registry("1001"); len(nodes) != 1 {
		t.Fatalf("registry lists %d nodes, want only a", len(nodes))
	}
}
