package cli

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

var b64 = base64.RawURLEncoding

// lockedBuffer is a bytes.Buffer safe for the pipe's goroutines; lines receives each completed line.
type lockedBuffer struct {
	mu    sync.Mutex
	b     bytes.Buffer
	lines chan string
}

func newLockedBuffer() *lockedBuffer { return &lockedBuffer{lines: make(chan string, 16)} }

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	start := l.b.Len()
	l.b.Write(p)
	all := l.b.Bytes()
	for i := start; i < len(all); i++ {
		if all[i] == '\n' {
			j := bytes.LastIndexByte(all[:i], '\n') + 1
			select {
			case l.lines <- string(all[j : i+1]):
			default:
			}
		}
	}
	return len(p), nil
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// meshNamed is meshOfTwo with a chosen name for the founder.
func meshNamed(t *testing.T, ctx context.Context, rs *relaytest.Server, aName string) (a, b *state.Store) {
	t.Helper()
	a = tmpStore(t)
	aid, _, _ := a.EnsureIdentity()
	a.SaveConfig(state.Config{Relay: rs.URL, Name: aName})
	if _, err := mesh.Found(a, aid, aName, 1); err != nil {
		t.Fatal(err)
	}
	startNode(t, ctx, rs, a)
	var inv struct{ Token string }
	if err := daemon.Call(a, daemon.Request{Op: "invite", TTLMs: 60000}, &inv); err != nil {
		t.Fatal(err)
	}
	tok, _ := mesh.ParseToken(inv.Token)
	b = tmpStore(t)
	bid, _, _ := b.EnsureIdentity()
	b.SaveConfig(state.Config{Relay: rs.URL, Name: "b"})
	s, err := daemon.Join(ctx, b, bid, tok, "b")
	if err != nil {
		t.Fatal(err)
	}
	s.Save()
	startNode(t, ctx, rs, b)
	return a, b
}

func memberOf(t *testing.T, st *state.Store, name string) mesh.Member {
	t.Helper()
	var ls daemon.LsReply
	if err := daemon.Call(st, daemon.Request{Op: "ls"}, &ls); err != nil {
		t.Fatal(err)
	}
	for _, m := range ls.Members {
		if m.Name == name {
			return m.Member
		}
	}
	t.Fatalf("no member %q", name)
	return mesh.Member{}
}

// countingRelay is a relay URL whose every connection is counted and dropped.
func countingRelay(t *testing.T) (string, *atomic.Int64) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	var n atomic.Int64
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			n.Add(1)
			c.Close()
		}
	}()
	return "http://" + ln.Addr().String(), &n
}

func svcMAC(key []byte, label string, parts ...[]byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(label))
	for _, p := range parts {
		h.Write(p)
	}
	return h.Sum(nil)
}

// echoProgram is a registered service that proves key and echoes the payload.
func echoProgram(t *testing.T, name string, key []byte) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				r := bufio.NewReader(c)
				line1, err := r.ReadString('\n')
				if err != nil || len(line1) != 53 {
					return
				}
				nd, _ := b64.DecodeString(line1[9:52])
				ng := make([]byte, 32)
				rand.Read(ng)
				c.Write([]byte(b64.EncodeToString(ng) + " " + b64.EncodeToString(svcMAC(key, "pen-svc/1 "+name, nd, ng)) + "\n"))
				if _, err := r.ReadBytes('\n'); err != nil {
					return
				}
				io.Copy(c, r)
				c.(*net.TCPConn).CloseWrite()
			}()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

// registerRaw registers name on st's daemon over the control socket and keeps the holder open.
func registerRaw(t *testing.T, st *state.Store, name string, port int, key []byte) net.Conn {
	t.Helper()
	c, err := net.Dial("unix", daemon.SocketPath(st))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	b, _ := json.Marshal(map[string]any{"op": "service.register", "name": name, "port": port, "key": b64.EncodeToString(key)})
	c.Write(append(b, '\n'))
	line, err := bufio.NewReader(c).ReadBytes('\n')
	if err != nil || !bytes.Contains(line, []byte(`"t":"registered"`)) {
		t.Fatalf("register %s: %q, %v", name, line, err)
	}
	return c
}

func TestPipeNodeTakesOnlyAnExactNodeIDAndNeverDialsAMemberNamedLikeOne(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	gone := "aaaaaaaaaaaaaaaaaaaaaaaaaa" // the shape of a node id that is not a member, used as a member's name
	_, b := meshNamed(t, ctx, rs, gone)
	named := memberOf(t, b, gone)
	url, dials := countingRelay(t)
	t.Setenv("PEN_HOME", b.Dir)
	t.Setenv("PEN_RELAYS", url)
	Stdin = strings.NewReader("")
	defer func() { Stdin = os.Stdin }()
	var out, errOut bytes.Buffer
	code := RunPipe([]string{"--node", gone, "--noise", named.NoisePub, "22"}, &out, &errOut)
	if code != 255 || !strings.Contains(errOut.String(), "not a member") {
		t.Fatalf("exit %d, stderr %q; want 255 and not a member", code, errOut.String())
	}
	if n := dials.Load(); n != 0 {
		t.Fatalf("pipe dialed %d time(s)", n)
	}
}

func TestPipeNodeRefusesANoiseKeyThatDiffersFromTheViewBeforeAnyDial(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	_, b := meshOfTwo(t, ctx, rs)
	am := memberOf(t, b, "a")
	t.Setenv("PEN_HOME", b.Dir)
	Stdin = strings.NewReader("")
	defer func() { Stdin = os.Stdin }()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		if c, err := ln.Accept(); err == nil {
			c.Close()
		}
	}()
	var okOut, okErr bytes.Buffer
	if code := RunPipe([]string{"--node", am.NodeID, "--noise", am.NoisePub, strconv.Itoa(ln.Addr().(*net.TCPAddr).Port)}, &okOut, &okErr); code != 0 {
		t.Fatalf("the matching key: exit %d, stderr %q; want 0", code, okErr.String())
	}
	url, dials := countingRelay(t)
	t.Setenv("PEN_RELAYS", url)
	other := make([]byte, 32)
	rand.Read(other)
	for _, args := range [][]string{
		{"--node", am.NodeID, "--noise", b64.EncodeToString(other), "22"},
		{"--node", am.NodeID, "22"},
		{"--node", am.NodeID, "--noise", am.NoisePub},
	} {
		var out, errOut bytes.Buffer
		if code := RunPipe(args, &out, &errOut); code != 255 {
			t.Fatalf("%v: exit %d, stderr %q; want 255", args, code, errOut.String())
		}
	}
	if n := dials.Load(); n != 0 {
		t.Fatalf("pipe dialed %d time(s)", n)
	}
}

// firstRead calls at once, then serves data, at the pipe's first read of stdin.
type firstRead struct {
	once sync.Once
	at   func()
	r    io.Reader
}

func (f *firstRead) Read(p []byte) (int, error) {
	f.once.Do(f.at)
	return f.r.Read(p)
}

func TestPipeServiceWritesTheReadyLineBeforeItReadsStdin(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a, b := meshOfTwo(t, ctx, rs)
	key := make([]byte, 32)
	rand.Read(key)
	registerRaw(t, a, "goat", echoProgram(t, "goat", key), key)
	am := memberOf(t, b, "a")
	t.Setenv("PEN_HOME", b.Dir)
	t.Setenv("PEN_TRACE", "1") // the exact form ignores it, so nothing precedes the ready line
	out, errOut := newLockedBuffer(), newLockedBuffer()
	var atRead, outAtRead string
	Stdin = &firstRead{at: func() { atRead, outAtRead = errOut.String(), out.String() }, r: strings.NewReader("hello")}
	defer func() { Stdin = os.Stdin }()
	if code := RunPipe([]string{"--node", am.NodeID, "--noise", am.NoisePub, "@goat"}, out, errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	if want := "pen-ready v1 " + am.NodeID + " " + am.NoisePub + "\n"; atRead != want || outAtRead != "" {
		t.Fatalf("at the first stdin read: stderr %q stdout %q; want only the ready line %q", atRead, outAtRead, want)
	}
	if out.String() != "hello" {
		t.Fatalf("stdout %q", out.String())
	}
}

func TestPipeNodeWithAPortOpensATCPStreamWithoutAReadyLine(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	_, b := meshOfTwo(t, ctx, rs)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		c.Write([]byte("SSH-2.0-test\r\n"))
		io.Copy(io.Discard, c)
		c.Close()
	}()
	am := memberOf(t, b, "a")
	Stdin = strings.NewReader("")
	defer func() { Stdin = os.Stdin }()
	var out, errOut bytes.Buffer
	if code := RunPipe([]string{"--home", b.Dir, "--node", am.NodeID, "--noise", am.NoisePub, strconv.Itoa(ln.Addr().(*net.TCPAddr).Port)}, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	if out.String() != "SSH-2.0-test\r\n" || errOut.String() != "" {
		t.Fatalf("stdout %q stderr %q", out.String(), errOut.String())
	}
}

func TestServiceRegisterTakesTheKeyOnlyFromStdinAndExitsByHowTheRegistrationEnds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a, b := meshOfTwo(t, ctx, rs)
	key := make([]byte, 32)
	rand.Read(key)
	port := echoProgram(t, "goat", key)
	t.Setenv("PEN_HOME", a.Dir)

	// A key given as an argument is refused before anything is registered.
	var out0, err0 bytes.Buffer
	if code := RunService([]string{"register", "goat", "--port", strconv.Itoa(port), b64.EncodeToString(key)}, &out0, &err0); code != 2 {
		t.Fatalf("a key in argv: exit %d, stderr %q; want 2", code, err0.String())
	}

	in, w := io.Pipe()
	Stdin = io.MultiReader(strings.NewReader(b64.EncodeToString(key)+"\n"), in)
	defer func() { Stdin = os.Stdin }()
	out, errOut := newLockedBuffer(), newLockedBuffer()
	code := make(chan int, 1)
	go func() { code <- RunService([]string{"register", "goat", "--port", strconv.Itoa(port)}, out, errOut) }()
	var line string
	select {
	case line = <-out.lines:
	case rc := <-code:
		t.Fatalf("exit %d before registering, stderr %q", rc, errOut.String())
	}
	if !strings.HasPrefix(line, "pen-service v1 registered goat ") || len(strings.Fields(line)) != 5 {
		t.Fatalf("stdout %q", line)
	}
	am := memberOf(t, b, "a")
	var pout, perr bytes.Buffer
	Stdin = strings.NewReader("ping")
	if rc := RunPipe([]string{"--home", b.Dir, "--node", am.NodeID, "--noise", am.NoisePub, "@goat"}, &pout, &perr); rc != 0 || pout.String() != "ping" {
		t.Fatalf("delivery through the child's registration: exit %d stdout %q stderr %q", rc, pout.String(), perr.String())
	}
	other := make([]byte, 32)
	rand.Read(other)
	registerRaw(t, a, "goat", port, other)
	if rc := <-code; rc != 3 || !strings.Contains(errOut.String(), "replaced") {
		t.Fatalf("replaced: exit %d, stderr %q; want 3", rc, errOut.String())
	}
	w.Close()

	// Stdin reaching its end releases the registration and exits 0.
	in2, w2 := io.Pipe()
	Stdin = io.MultiReader(strings.NewReader(b64.EncodeToString(key)+"\n"), in2)
	out2, err2 := newLockedBuffer(), newLockedBuffer()
	go func() { code <- RunService([]string{"register", "other", "--port", strconv.Itoa(port)}, out2, err2) }()
	select {
	case <-out2.lines:
	case rc := <-code:
		t.Fatalf("exit %d before registering, stderr %q", rc, err2.String())
	}
	w2.Close()
	if rc := <-code; rc != 0 {
		t.Fatalf("stdin closed: exit %d, stderr %q; want 0", rc, err2.String())
	}
}

// sshG is ssh -G for host under cfg, or "" when this machine has no ssh.
func sshG(t *testing.T, cfg, host string) string {
	t.Helper()
	if _, err := exec.LookPath("ssh"); err != nil {
		return ""
	}
	path := filepath.Join(t.TempDir(), "config")
	if err := os.WriteFile(path, []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("ssh", "-G", "-F", path, host).Output()
	if err != nil {
		t.Fatalf("ssh -G %s: %v", host, err)
	}
	return strings.ReplaceAll(string(out), "\r\n", "\n")
}

func block(cfg, host string) string {
	i := strings.Index(cfg, "Host "+host+"\n")
	if i < 0 {
		return ""
	}
	rest := cfg[i+len("Host "+host+"\n"):]
	if j := strings.Index(rest, "\nHost "); j >= 0 {
		rest = rest[:j+1]
	}
	return rest
}

func TestSSHConfigWritesAnExactNodeIDBlockPerMemberWithoutConnectionReuse(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	_, b := meshOfTwo(t, ctx, rs)
	am := memberOf(t, b, "a")
	t.Setenv("PEN_HOME", b.Dir)
	t.Setenv("PEN_SSH_DIR", t.TempDir())
	var out, errOut bytes.Buffer
	if code := RunSSHConfig(nil, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	cfg := out.String()
	blk := block(cfg, "pen-"+am.NodeID)
	if blk == "" {
		t.Fatalf("no pen-<nodeId> block:\n%s", cfg)
	}
	// On Windows the prefix carries --home after "pipe" (ssh runs ProxyCommand without a shell there).
	if !strings.Contains(blk, " pipe ") || !strings.Contains(blk, " --node "+am.NodeID+" --noise "+am.NoisePub+" 22\n") || strings.Contains(blk, "%n") {
		t.Fatalf("pen-<nodeId> block is not the exact form:\n%s", blk)
	}
	if i := strings.Index(cfg, "Host pen-"+am.NodeID+"\n"); i < strings.Index(cfg, "Host pen-a\n") || i > strings.Index(cfg, "Host "+fallbackHost+"\n") {
		t.Fatal("the pen-<nodeId> blocks must come after the name blocks and before pen-*")
	}
	if connectionReuse && (!strings.Contains(blk, "ControlMaster no\n") || !strings.Contains(blk, "ControlPath none\n")) {
		t.Fatalf("pen-<nodeId> block keeps connection reuse:\n%s", blk)
	}
	if g := sshG(t, cfg, "pen-"+am.NodeID); g != "" {
		if !strings.Contains(g, "--node "+am.NodeID+" --noise "+am.NoisePub+" 22") || !strings.Contains(g, "controlmaster false\n") || (strings.Contains(g, "\ncontrolpath ") && !strings.Contains(g, "\ncontrolpath none\n")) {
			t.Fatalf("effective config for pen-<nodeId>:\n%s", g)
		}
	}
}

func TestSSHConfigKeepsEveryNameBlockAsItWasEvenANameThatEqualsANodeID(t *testing.T) {
	k := func(b byte) string { return b64.EncodeToString(bytes.Repeat([]byte{b}, 32)) }
	id1, id2, id3 := strings.Repeat("c", 26), strings.Repeat("d", 26), strings.Repeat("e", 26)
	hosts := []sshHost{
		{Name: "dup", User: "u1", NodeID: id1, NoisePub: k(1)},
		{Name: "dup", User: "u2", NodeID: id2, NoisePub: k(2)},
		{Name: id1, NodeID: id3, NoisePub: k(3)}, // no User: the exact block must not lend it one
	}
	cmd := proxyPrefix("/bin/pen", "")
	got := sshConfigText(cmd, "/k/known_hosts", "/k", hosts)
	var named []sshHost
	for _, h := range hosts {
		named = append(named, sshHost{Name: h.Name, User: h.User})
	}
	old := sshConfigText(cmd, "/k/known_hosts", "/k", named)
	fallback := old[strings.Index(old, "Host "+fallbackHost+"\n"):]
	if !strings.HasPrefix(got, strings.TrimSuffix(old, fallback)) || !strings.HasSuffix(got, fallback) {
		t.Fatalf("name blocks changed:\n%s\nwant the name blocks of:\n%s", got, old)
	}
	if g := sshG(t, got, "pen-"+id1); g != "" {
		// The alias keeps the name block it had: the same user and route as before this change.
		if g != sshG(t, old, "pen-"+id1) {
			t.Fatalf("pen-<id1> changed for people:\n%s", g)
		}
	}
	if strings.Contains(got, "Host pen-"+id1+"\n    User u1") || strings.Count(got, "Host pen-"+id1+"\n") != 1 {
		t.Fatalf("an id another member uses as a name got an exact block:\n%s", got)
	}
	if g := sshG(t, got, "pen-"+id2); g != "" && !strings.Contains(g, "--node "+id2+" --noise "+k(2)+" 22") {
		t.Fatalf("pen-<id2> is not exact:\n%s", g)
	}
	if g := sshG(t, got, "pen-dup"); g != "" && !strings.Contains(g, "\nuser u1\n") {
		t.Fatalf("pen-dup changed:\n%s", g)
	}
}

func TestServiceRegisterForwardsOpsAndPrintsEachAnswerBeforeItExitsAtTheEndOfStdin(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a, _ := meshOfTwo(t, ctx, rs)
	key := make([]byte, 32)
	rand.Read(key)
	port := echoProgram(t, "goat", key)
	t.Setenv("PEN_HOME", a.Dir)
	ops := `{"op":"service.clients","gen":1,"clients":[]}` + "\n" + `{"op":"service.clients","gen":1,"clients":[]}` + "\n"
	Stdin = strings.NewReader(b64.EncodeToString(key) + "\n" + ops + `{"op":"partial"`)
	defer func() { Stdin = os.Stdin }()
	var out, errOut bytes.Buffer
	if rc := RunService([]string{"register", "goat", "--port", strconv.Itoa(port)}, &out, &errOut); rc != 0 {
		t.Fatalf("exit %d, stderr %q", rc, errOut.String())
	}
	lines := strings.Split(strings.TrimSuffix(out.String(), "\n"), "\n")
	if len(lines) != 3 || !strings.HasPrefix(lines[0], "pen-service v1 registered goat ") ||
		lines[1] != `{"gen":1,"t":"clients"}` || !strings.Contains(lines[2], `"t":"refused"`) {
		t.Fatalf("stdout %q: want the registered line, then one answer per forwarded op and nothing for the partial line", out.String())
	}
}

func TestServiceRegisterRefusesToForwardAnOpLineOver4096Bytes(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a, _ := meshOfTwo(t, ctx, rs)
	key := make([]byte, 32)
	rand.Read(key)
	port := echoProgram(t, "goat", key)
	t.Setenv("PEN_HOME", a.Dir)
	long := `{"op":"service.clients","gen":1,"clients":[]` + strings.Repeat(" ", 4096) + "}\n"
	Stdin = strings.NewReader(b64.EncodeToString(key) + "\n" + long)
	defer func() { Stdin = os.Stdin }()
	var out, errOut bytes.Buffer
	if rc := RunService([]string{"register", "goat", "--port", strconv.Itoa(port)}, &out, &errOut); rc != 2 {
		t.Fatalf("exit %d, stdout %q, stderr %q; want 2", rc, out.String(), errOut.String())
	}
	if strings.Count(out.String(), "\n") != 1 {
		t.Fatalf("stdout %q: the long line was forwarded", out.String())
	}
}

func TestServiceRegisterFailsWhenTheNodeClosesBeforeAnsweringEveryForwardedOp(t *testing.T) {
	dir, err := os.MkdirTemp(tmpRoot(), "pen")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	st, err := state.OpenDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	// A node that registers and then, like a v1.2 node, ignores the ops and ends the registration at the half-close.
	// It learns of the half-close from the grace seam, which the child reaches once it half-closed, since a read on
	// Windows may miss the half-close itself. Off Windows the child has no grace here, so only its read of the node's
	// close ends it, with the closed-before-answering message. On Windows that read may miss the close too, so the
	// grace ends once the node has closed, and either message counts the op.
	nodeClosed := make(chan time.Time)
	var grace <-chan time.Time
	want := "before answering 1 forwarded op(s)"
	if runtime.GOOS == "windows" {
		grace, want = nodeClosed, "1 forwarded op(s)"
	}
	halfClosed := halfCloseSeam(t, grace)
	ln, err := net.Listen("unix", daemon.SocketPath(st))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		r := bufio.NewReader(c)
		r.ReadBytes('\n')
		c.Write([]byte(`{"t":"registered","id":"r","name":"goat","port":1}` + "\n"))
		r.ReadBytes('\n')
		<-halfClosed
		c.Close()
		close(nodeClosed)
	}()
	t.Setenv("PEN_HOME", dir)
	key := make([]byte, 32)
	rand.Read(key)
	Stdin = strings.NewReader(b64.EncodeToString(key) + "\n" + `{"op":"service.clients","gen":1,"clients":[]}` + "\n")
	defer func() { Stdin = os.Stdin }()
	var out, errOut bytes.Buffer
	if rc := RunService([]string{"register", "goat", "--port", "1"}, &out, &errOut); rc != 1 || !strings.Contains(errOut.String(), want) {
		t.Fatalf("exit %d, stderr %q; want 1 and %q", rc, errOut.String(), want)
	}
}

// failingSink is a node connection whose op write or half-close fails.
type failingSink struct{ write, closeWrite error }

func (f failingSink) Write(p []byte) (int, error) {
	if f.write != nil {
		return 0, f.write
	}
	return len(p), nil
}

func (f failingSink) CloseWrite() error { return f.closeWrite }

// Regression (a hang on goat-test-pen-windows): an op the child cannot write, or a half-close that fails while an op is
// unanswered, ends the child with exit 2 and the reason; the end is never left to answers that may not come.
func TestServiceRegisterExitsWhenItCannotForwardAnOpOrHalfClose(t *testing.T) {
	op := `{"op":"service.clients","gen":1,"clients":[]}` + "\n"
	for _, c := range []struct {
		name string
		sink failingSink
	}{
		{"op write", failingSink{write: errors.New("broken pipe")}},
		{"half-close", failingSink{closeWrite: errors.New("shutdown failed")}},
	} {
		t.Run(c.name, func(t *testing.T) {
			var s serviceCount
			var errOut bytes.Buffer
			code, ok := forwardOps(bufio.NewReader(strings.NewReader(op)), c.sink, &s, &errOut)
			if !ok || code != serviceFailed || errOut.Len() == 0 {
				t.Fatalf("forwardOps ended with %d (decided %v), stderr %q; want exit 2 and the reason", code, ok, errOut.String())
			}
		})
	}
}

// halfCloseSeam replaces the child's end grace timer with grace and returns a channel that closes when the child
// starts that timer, which it does right after it half-closed.
func halfCloseSeam(t *testing.T, grace <-chan time.Time) <-chan struct{} {
	t.Helper()
	halfClosed := make(chan struct{})
	was := afterEndGrace
	afterEndGrace = func() <-chan time.Time {
		close(halfClosed)
		return grace
	}
	t.Cleanup(func() { afterEndGrace = was })
	return halfClosed
}

// fakeNodeThatMissesTheEnd is a node that registers, reads one op, answers it when answer is true, and then keeps its
// side open, as a node whose read missed the half-close does on Windows. It closes only when the test ends.
func fakeNodeThatMissesTheEnd(t *testing.T, answer bool) {
	t.Helper()
	dir, err := os.MkdirTemp(tmpRoot(), "pen")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	st, err := state.OpenDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("unix", daemon.SocketPath(st))
	if err != nil {
		t.Fatal(err)
	}
	release := make(chan struct{})
	t.Cleanup(func() { close(release); ln.Close() })
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		r := bufio.NewReader(c)
		r.ReadBytes('\n')
		c.Write([]byte(`{"t":"registered","id":"r","name":"goat","port":1}` + "\n"))
		r.ReadBytes('\n')
		if answer {
			c.Write([]byte(`{"t":"clients","gen":1}` + "\n"))
		}
		<-release
	}()
	t.Setenv("PEN_HOME", dir)
}

// printSignal collects what is written and closes printed once a write contains want.
type printSignal struct {
	mu      sync.Mutex
	buf     bytes.Buffer
	want    string
	once    sync.Once
	printed chan struct{}
}

func (w *printSignal) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.buf.Write(p)
	if strings.Contains(string(p), w.want) {
		w.once.Do(func() { close(w.printed) })
	}
	return len(p), nil
}

// Regression (a hang on goat-test-pen-windows): a node that never closes after the half-close, as one whose read
// missed it, leaves the child waiting only until the end of its grace; then it exits 1 counting the unanswered ops, or 0
// when every op was answered.
func TestServiceRegisterEndsAtTheGraceWhenTheNodeMissesItsHalfClose(t *testing.T) {
	for _, c := range []struct {
		name   string
		answer bool
		rc     int
		stderr string
	}{
		{"op unanswered", false, 1, "did not answer 1 forwarded op(s)"},
		{"op answered", true, 0, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			fakeNodeThatMissesTheEnd(t, c.answer)
			grace := make(chan time.Time)
			halfClosed := halfCloseSeam(t, grace)
			key := make([]byte, 32)
			rand.Read(key)
			Stdin = strings.NewReader(b64.EncodeToString(key) + "\n" + `{"op":"service.clients","gen":1,"clients":[]}` + "\n")
			defer func() { Stdin = os.Stdin }()
			out := &printSignal{want: `"t":"clients"`, printed: make(chan struct{})}
			go func() {
				<-halfClosed
				if c.answer {
					<-out.printed
				}
				close(grace)
			}()
			var errOut bytes.Buffer
			rc := RunService([]string{"register", "goat", "--port", "1"}, out, &errOut)
			if rc != c.rc || !strings.Contains(errOut.String(), c.stderr) {
				t.Fatalf("exit %d, stderr %q; want %d and %q", rc, errOut.String(), c.rc, c.stderr)
			}
		})
	}
}

// timeoutOnce returns its first part, then one read timeout, then the rest.
type timeoutOnce struct{ parts []string }

func (r *timeoutOnce) Read(p []byte) (int, error) {
	if len(r.parts) == 0 {
		return 0, io.EOF
	}
	part := r.parts[0]
	r.parts = r.parts[1:]
	if part == "" {
		return 0, &net.OpError{Op: "read", Net: "unix", Err: os.ErrDeadlineExceeded}
	}
	return copy(p, part), nil
}

// A read that reaches its recheck deadline in the middle of a node line is replaced by a fresh one that keeps the
// part already read.
func TestANodeLineSurvivesARecheckInItsMiddle(t *testing.T) {
	r := bufio.NewReader(&timeoutOnce{parts: []string{`{"t":"cli`, "", `ents"}` + "\n"}})
	rechecks := 0
	line, err := readCappedLine(r, serviceAnswerCap, func(err error) bool {
		rechecks++
		return errors.Is(err, os.ErrDeadlineExceeded)
	})
	if err != nil || string(line) != `{"t":"clients"}`+"\n" || rechecks != 1 {
		t.Fatalf("line %q, err %v after %d recheck(s); want the whole line after 1", line, err, rechecks)
	}
}
