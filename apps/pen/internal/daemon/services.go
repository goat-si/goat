package daemon

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/session"
	"github.com/goat-si/goat/apps/pen/internal/stream"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// Service limits (contract "Services").
const (
	maxServices   = 8
	maxDeliveries = 32
	// answerCap bounds line 2 up to its LF; a well-formed line 2 is 88 bytes.
	answerCap = 128
)

// Local delivery deadlines (variables for tests).
var (
	deliveryDialTimeout   = 5 * time.Second
	deliveryAnswerTimeout = 5 * time.Second
)

// strictB64 is base64url without padding that refuses non-zero trailing bits, so one key has one text.
var strictB64 = base64.RawURLEncoding.Strict()

var regIDs = base32.StdEncoding.WithPadding(base32.NoPadding)

// ValidServiceName reports a service name: 1 to 32 of [a-z0-9-], starting with a letter, never "pen"
// (the node's own MAC label).
func ValidServiceName(s string) bool {
	if len(s) < 1 || len(s) > 32 || s == "pen" {
		return false
	}
	for i, c := range s {
		letter := c >= 'a' && c <= 'z'
		if i == 0 && !letter {
			return false
		}
		if !letter && !(c >= '0' && c <= '9') && c != '-' {
			return false
		}
	}
	return true
}

// decodeKey32 decodes exactly 43 canonical base64url characters to 32 bytes.
func decodeKey32(s string) ([]byte, bool) {
	if len(s) != 43 {
		return nil, false
	}
	b, err := strictB64.DecodeString(s)
	if err != nil || len(b) != 32 {
		return nil, false
	}
	return b, true
}

// serviceReg is one registration; it lives as long as its holder's control connection.
type serviceReg struct {
	id     string
	name   string
	port   int
	key    []byte
	holder net.Conn
	// liveMu guards draining: once the holder's drain starts it owns the connection's read deadline (rearm).
	liveMu   sync.Mutex
	draining bool
	// wmu orders the holder's registered answer and a replaced notice.
	wmu sync.Mutex
	// ended and conns are guarded by serviceBook.mu: conns are the deliveries committed to it; once it ended,
	// endConns are the deliveries its single teardown (endRegistration) closes.
	ended    bool
	conns    map[net.Conn]struct{}
	endConns []net.Conn
	// endStarted (guarded by serviceBook.mu) marks that the teardown has an owner, whoever ended the registration
	// first; endDone closes when it finished.
	endStarted bool
	endDone    chan struct{}
	// handshakes are the admitted client and pairing handshakes, guarded by serviceBook.mu (clients.go).
	handshakes map[*handshake]struct{}
	// gen, clients and invite are the v1.3 ops' state, guarded by serviceBook.mu: the last list generation applied,
	// the listed client keys (noisePub to client id) and the live service invite. out carries answers and events.
	gen     uint64
	clients map[string]string
	invite  *serviceInvite
	out     *holderQueue
}

// serviceBook holds the registrations. Its mutex is a leaf: nothing is called while it is held.
type serviceBook struct {
	mu       sync.Mutex
	byName   map[string]*serviceReg
	inflight int
	logged   map[string]time.Time
	// phones are the held phone slots (phoneslots.go); onPhones is the PhoneSlots test hook.
	phones   phoneCounts
	onPhones func(total int)
}

var errTooManyServices = fmt.Errorf("this node already holds %d service names", maxServices)

// add makes reg current for its name and returns the registration it replaced, if any, already ended.
func (b *serviceBook) add(reg *serviceReg) (*serviceReg, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.byName == nil {
		b.byName = map[string]*serviceReg{}
	}
	old := b.byName[reg.name]
	if old == nil && len(b.byName) >= maxServices {
		return nil, errTooManyServices
	}
	b.byName[reg.name] = reg
	if old == nil {
		return nil, nil
	}
	b.endLocked(old)
	return old, nil
}

// endLocked ends reg: it stops being current, forgets its list and invite, and hands its committed deliveries to
// its teardown.
func (b *serviceBook) endLocked(reg *serviceReg) {
	if b.byName[reg.name] == reg {
		delete(b.byName, reg.name)
	}
	if reg.ended {
		return
	}
	reg.ended = true
	reg.clients, reg.invite = nil, nil
	for c := range reg.conns {
		reg.endConns = append(reg.endConns, c)
	}
	reg.conns = nil
}

// end removes reg (only reg, never a newer registration of its name).
func (b *serviceBook) end(reg *serviceReg) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.endLocked(reg)
}

func (b *serviceBook) lookup(name string) *serviceReg {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.byName[name]
}

// commit is the point a delivery belongs to reg: only while reg is still current for its name.
func (b *serviceBook) commit(reg *serviceReg, c net.Conn) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if reg.ended || b.byName[reg.name] != reg {
		return false
	}
	if reg.conns == nil {
		reg.conns = map[net.Conn]struct{}{}
	}
	reg.conns[c] = struct{}{}
	return true
}

func (b *serviceBook) uncommit(reg *serviceReg, c net.Conn) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(reg.conns, c)
}

func (b *serviceBook) acquire() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.inflight >= maxDeliveries {
		return false
	}
	b.inflight++
	return true
}

func (b *serviceBook) release() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.inflight--
}

// shouldLog reports whether cause was not logged in the last minute. Causes are a fixed set.
func (b *serviceBook) shouldLog(cause string, now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.logged == nil {
		b.logged = map[string]time.Time{}
	}
	if at, ok := b.logged[cause]; ok && now.Sub(at) < time.Minute && now.Sub(at) >= 0 {
		return false
	}
	b.logged[cause] = now
	return true
}

// Delivery failure causes, the fixed set the log is rate limited by.
const (
	causeDial      = "dial"
	causeDeadline  = "deadline"
	causeMalformed = "malformed"
	causeProof     = "proof"
	causeReplaced  = "replaced"
)

type deliveryError struct {
	cause string
	err   error
}

func (e *deliveryError) Error() string { return e.cause + ": " + e.err.Error() }

func failed(cause string, err error) error { return &deliveryError{cause: cause, err: err} }

// ioCause names a failed read or write on the local connection.
func ioCause(err error) error {
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return failed(causeDeadline, err)
	}
	return failed(causeMalformed, err)
}

func closeAll(conns []net.Conn) {
	for _, c := range conns {
		c.Close()
	}
}

// serveService delivers a confirmed service stream to the program that holds its name (contract
// "Local delivery") and splices it like a tcp stream.
func (d *Daemon) serveService(ctx context.Context, sec *session.Secure) {
	if !d.svc.acquire() {
		sec.Close(wire.CodeCaps)
		return
	}
	held := true
	releaseSlot := func() {
		if held {
			held = false
			d.svc.release()
		}
	}
	defer releaseSlot()
	reg := d.svc.lookup(sec.Payload.Name)
	if reg == nil {
		sec.Close(wire.CodeOffline)
		return
	}
	conn, err := d.deliverTo(ctx, reg, sec.RemoteStatic, nil)
	if err != nil {
		d.logDelivery(reg, err)
		sec.Close(wire.CodeOffline)
		return
	}
	defer conn.Close()
	defer d.svc.uncommit(reg, conn)
	releaseSlot()
	if err := stream.Splice(ctx, sec, conn, conn, conn.CloseWrite); err != nil && !stream.Delivered(err) {
		// As in serveTCP: the program reads a reset, not a clean end, when the caller's stream stopped short of its FIN.
		conn.SetLinger(0)
	}
}

// logDelivery logs a failed delivery under its cause, at most once a minute per cause.
func (d *Daemon) logDelivery(reg *serviceReg, err error) {
	cause := causeMalformed
	var de *deliveryError
	if errors.As(err, &de) {
		cause = de.cause
	}
	if d.svc.shouldLog(cause, d.now()) {
		d.opt.Logf("service %s: delivery failed (%v); is the program on port %d the one that registered it?", reg.name, err, reg.port)
	}
}

// deliverTo dials reg's port and runs the mutual proof for the caller with Noise key remote: a member when l is
// nil, otherwise the client or pairing session l. It returns the connection committed to reg, after line 3, ready
// for the payload.
func (d *Daemon) deliverTo(ctx context.Context, reg *serviceReg, remote []byte, l *live) (*net.TCPConn, error) {
	dctx, cancel := context.WithTimeout(ctx, deliveryDialTimeout)
	c, err := (&net.Dialer{}).DialContext(dctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(reg.port)))
	cancel()
	if err != nil {
		return nil, failed(causeDial, err)
	}
	tc := c.(*net.TCPConn)
	ok := false
	defer func() {
		if !ok {
			tc.Close()
		}
	}()
	if err := tc.SetDeadline(time.Now().Add(deliveryAnswerTimeout)); err != nil {
		return nil, failed(causeDial, err)
	}
	nd := make([]byte, 32)
	rand.Read(nd)
	if _, err := io.WriteString(tc, "PENSVC/1 "+strictB64.EncodeToString(nd)+"\n"); err != nil {
		return nil, ioCause(err)
	}
	line, err := readLineCap(tc, answerCap)
	if err != nil {
		return nil, ioCause(err)
	}
	ng, a, err := parseAnswer(line)
	if err != nil {
		return nil, failed(causeMalformed, err)
	}
	if !hmac.Equal(a, serviceMAC(reg.key, "pen-svc/1 "+reg.name, nd, ng)) {
		return nil, failed(causeProof, errors.New("the program's answer does not prove the registered key"))
	}
	var j []byte
	if l != nil {
		// The commit and line 3 happen under the session's gate, which its close owner takes first.
		l.gate.Lock()
		defer l.gate.Unlock()
		if j, err = d.commitClient(reg, tc, l); err != nil {
			return nil, err
		}
	} else if j, err = d.memberLine(reg, tc, remote); err != nil {
		return nil, err
	}
	b := serviceMAC(reg.key, "pen-svc/1 pen", nd, ng, j)
	if _, err := io.WriteString(tc, string(j)+" "+strictB64.EncodeToString(b)+"\n"); err != nil {
		d.svc.uncommit(reg, tc)
		return nil, ioCause(err)
	}
	if err := tc.SetDeadline(time.Time{}); err != nil {
		d.svc.uncommit(reg, tc)
		return nil, failed(causeDeadline, err)
	}
	ok = true
	return tc, nil
}

// memberLine commits a member's delivery and renders its identity line: the caller as the view holds it now, after
// the commit and before line 3.
func (d *Daemon) memberLine(reg *serviceReg, tc net.Conn, remote []byte) ([]byte, error) {
	if !d.svc.commit(reg, tc) {
		return nil, failed(causeReplaced, errors.New("the registration ended during the delivery"))
	}
	v := d.view()
	caller, member := v.MemberByNoise(remote)
	if !member {
		d.svc.uncommit(reg, tc)
		return nil, failed(causeReplaced, errors.New("the caller is no longer a member"))
	}
	j, err := identityLine(v.MeshID, d.nodeID, caller, reg.name)
	if err != nil {
		d.svc.uncommit(reg, tc)
		return nil, failed(causeMalformed, err)
	}
	return j, nil
}

// parseAnswer decodes line 2, "<Ng> <A>" LF, exactly: 88 bytes, canonical base64url, no CR.
func parseAnswer(line []byte) (ng, a []byte, err error) {
	if len(line) != 88 || line[43] != ' ' || line[87] != '\n' {
		return nil, nil, errors.New("line 2 is not <Ng> <A>")
	}
	ng, okNg := decodeKey32(string(line[:43]))
	a, okA := decodeKey32(string(line[44:87]))
	if !okNg || !okA {
		return nil, nil, errors.New("line 2 is not canonical base64url")
	}
	return ng, a, nil
}

// serviceMAC is HMAC-SHA256 keyed with key over label || parts.
func serviceMAC(key []byte, label string, parts ...[]byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(label))
	for _, p := range parts {
		h.Write(p)
	}
	return h.Sum(nil)
}

// readLineCap reads one byte at a time up to and including LF, at most limit bytes, so nothing past the
// line is consumed.
func readLineCap(r io.Reader, limit int) ([]byte, error) {
	buf := make([]byte, 0, limit)
	one := make([]byte, 1)
	for len(buf) < limit {
		if _, err := io.ReadFull(r, one); err != nil {
			return nil, err
		}
		buf = append(buf, one[0])
		if one[0] == '\n' {
			return buf, nil
		}
	}
	return nil, errors.New("line over its cap")
}

// identityLine renders J (contract "Local delivery", step 3). Every value must come from its identifier
// alphabet, so none needs escaping; a value that does not is refused rather than escaped.
func identityLine(meshID, self string, caller mesh.Member, name string) ([]byte, error) {
	for _, id := range []string{meshID, self, caller.NodeID} {
		if !validID(id) {
			return nil, fmt.Errorf("identifier %q is not 26 base32 characters", id)
		}
	}
	for _, k := range []string{caller.SignPub, caller.NoisePub} {
		if _, ok := decodeKey32(k); !ok {
			return nil, errors.New("a caller key is not canonical base64url")
		}
	}
	if !ident.ValidName(caller.Name) || !ValidServiceName(name) {
		return nil, errors.New("a name is outside its alphabet")
	}
	return []byte(`{"v":1,"mesh":"` + meshID + `","self":"` + self + `","caller":{"nodeId":"` + caller.NodeID +
		`","signPub":"` + caller.SignPub + `","noisePub":"` + caller.NoisePub + `","name":"` + caller.Name +
		`"},"stream":"` + name + `"}`), nil
}

// validID reports 26 characters of lowercase base32 (node and mesh ids).
func validID(s string) bool {
	if len(s) != 26 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= '2' && c <= '7') {
			return false
		}
	}
	return true
}

// controlRegister runs op service.register on the control socket (never on the dashboard path): the
// registration lives until c closes, the daemon stops, or a newer registration replaces it. r continues the
// connection's reader, so ops sent with the request are not lost, and lr is lifted for the ops that follow. It
// reports whether the registration's holder queue took c, and so ends it.
func (d *Daemon) controlRegister(ctx context.Context, c net.Conn, r *bufio.Reader, lr *io.LimitedReader, req Request, reply func(any), fail func(error)) bool {
	if !ValidServiceName(req.Name) {
		fail(errors.New("a service name is 1 to 32 of a-z 0-9 -, starts with a letter, and is not pen"))
		return false
	}
	if req.Port < 1 || req.Port > 65535 {
		fail(errors.New("the port must be 1 to 65535"))
		return false
	}
	key, ok := decodeKey32(req.Key)
	if !ok {
		fail(errors.New("the key must be 32 bytes, base64url without padding"))
		return false
	}
	idb := make([]byte, 16)
	rand.Read(idb)
	reg := &serviceReg{id: strings.ToLower(regIDs.EncodeToString(idb)), name: req.Name, port: req.Port, key: key, holder: c,
		endDone: make(chan struct{})}
	reg.out = newHolderQueue(c, func(c net.Conn) {
		reg.drainStarts()
		d.spawn(func() { discardAndClose(ctx, c) })
	})
	reg.out.whileWriting = d.opt.HolderWriting
	reg.out.whileFilling = d.opt.HolderFilling
	reg.wmu.Lock()
	old, err := d.svc.add(reg)
	if err != nil {
		reg.wmu.Unlock()
		fail(err)
		return false
	}
	if old != nil {
		// The old registration's sessions and deliveries start closing before anything is written to either holder,
		// so no holder write delays them.
		d.spawn(func() { d.endRegistration(old) })
	}
	if d.opt.Registering != nil {
		d.opt.Registering()
	}
	reply(map[string]any{"t": "registered", "id": reg.id, "name": reg.name, "port": reg.port})
	d.spawn(reg.out.run)
	reg.wmu.Unlock()
	if old != nil {
		// The old holder is told beside its teardown, without waiting for its queued lines.
		old.wmu.Lock()
		old.wmu.Unlock()
		d.spawn(func() { old.out.failWith([]byte(`{"t":"replaced","id":"` + old.id + `"}` + "\n")) })
	}
	defer func() {
		reg.out.fail()
		d.svc.end(reg)
		d.endRegistration(reg)
		if d.opt.ServiceEnded != nil {
			d.opt.ServiceEnded(reg.id)
		}
	}()
	liftOpLimit(lr)
	d.serveOps(ctx, reg, r)
	return true
}
