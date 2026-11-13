package cli

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync/atomic"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
)

// Exit codes of pen service register (contract "Registration").
const (
	serviceReleased   = 0 // stdin ended: the program let the registration go
	serviceDaemonGone = 1
	serviceFailed     = 2
	serviceReplaced   = 3
)

// Line caps of the ops a holder forwards and the lines the node answers (contract "Ops on the registration").
const (
	serviceOpCap     = 4096
	serviceAnswerCap = 64 << 10
)

// RunService runs "pen service register <name> --port <P>", the child a program keeps for as long as it
// serves name. The key comes as one line on stdin, never as an argument, a variable or a file. Every later stdin
// line is an op it forwards to the node, and every line the node sends back is printed on stdout.
func RunService(args []string, stdout, stderr io.Writer) int {
	usage := "usage: pen service register <name> --port <port>   (the key comes on stdin)"
	die := func(err error) int {
		fmt.Fprintln(stderr, "pen service:", err)
		return serviceFailed
	}
	if len(args) == 0 || args[0] != "register" {
		return die(errors.New(usage))
	}
	fs := newFlags("service register", stderr)
	port := fs.Int("port", 0, "the loopback port the program listens on")
	pos, err := parse(fs, args[1:])
	if err != nil {
		return serviceFailed
	}
	if len(pos) != 1 {
		return die(errors.New(usage))
	}
	name := pos[0]
	if !daemon.ValidServiceName(name) {
		return die(fmt.Errorf("bad service name %q", name))
	}
	if *port < 1 || *port > 65535 {
		return die(errors.New("--port must be 1 to 65535"))
	}
	stdin := bufio.NewReaderSize(Stdin, serviceOpCap)
	key, err := readKeyLine(stdin)
	if err != nil {
		return die(err)
	}
	st, err := openState()
	if err != nil {
		return die(err)
	}
	cl, err := daemon.Dial(st)
	if err != nil {
		return die(err)
	}
	defer cl.Close()
	if err := cl.Send(daemon.Request{Op: "service.register", Name: name, Port: *port, Key: key}); err != nil {
		return die(err)
	}
	var reg struct{ T, ID string }
	if err := cl.Next(&reg); err != nil {
		return die(err)
	}
	if reg.T != "registered" {
		return die(fmt.Errorf("unexpected answer %q", reg.T))
	}
	fmt.Fprintf(stdout, "pen-service v1 registered %s %s\n", name, reg.ID)
	var s serviceCount
	ended := make(chan int, 3)
	go func() {
		if code, ok := forwardOps(stdin, cl, &s, stderr); ok {
			ended <- code
		}
	}()
	go func() {
		node := bufio.NewReaderSize(cl.Rest(), 4096)
		for {
			b, err := readCappedLine(node, serviceAnswerCap)
			if err != nil {
				if s.released.Load() && s.allAnswered() {
					ended <- serviceReleased
					return
				}
				if s.released.Load() {
					fmt.Fprintf(stderr, "pen service: the pen daemon closed the registration of %s before answering %d forwarded op(s)\n",
						name, s.forwarded.Load()-s.answered.Load())
					ended <- serviceDaemonGone
					return
				}
				fmt.Fprintf(stderr, "pen service: the pen daemon closed the registration of %s\n", name)
				ended <- serviceDaemonGone
				return
			}
			if len(b) == 1 { // the LF after the registered line, which Next leaves buffered
				continue
			}
			var notice struct{ T string }
			if json.Unmarshal(b, &notice) == nil && notice.T == "replaced" {
				fmt.Fprintf(stderr, "pen service: %s was replaced by a newer registration\n", name)
				ended <- serviceReplaced
				return
			}
			stdout.Write(b)
			switch notice.T {
			case "clients", "refused", "invite", "invite-cancelled":
				s.answered.Add(1)
			}
		}
	}()
	return <-ended
}

// serviceCount counts both sides: the node answers every op once, in order, and events (invite-burned,
// invite-exhausted) are not answers, so the end of stdin succeeds only once every forwarded op was answered.
type serviceCount struct {
	released            atomic.Bool
	forwarded, answered atomic.Int64
}

func (s *serviceCount) allAnswered() bool { return s.answered.Load() == s.forwarded.Load() }

// opSink is the side of the node's connection the ops go to.
type opSink interface {
	Write(p []byte) (int, error)
	CloseWrite() error
}

// forwardOps forwards each stdin line to the node until stdin ends, then half-closes. It returns the exit code when
// it decides how the registration ends, and ok false when the node's answers decide it. An op it cannot write, or a
// half-close that fails with an op unanswered, ends the child: the node could not answer it or end the registration.
func forwardOps(stdin *bufio.Reader, node opSink, s *serviceCount, stderr io.Writer) (int, bool) {
	for {
		op, err := readCappedLine(stdin, serviceOpCap)
		if errors.Is(err, io.EOF) {
			// Released: the node answers what it was sent, then ends the registration and closes.
			s.released.Store(true)
			if err := node.CloseWrite(); err != nil {
				if s.allAnswered() {
					return serviceReleased, true
				}
				fmt.Fprintf(stderr, "pen service: could not end the ops with %d unanswered: %v\n", s.forwarded.Load()-s.answered.Load(), err)
				return serviceFailed, true
			}
			return 0, false
		}
		if err != nil {
			fmt.Fprintln(stderr, "pen service:", err)
			return serviceFailed, true
		}
		s.forwarded.Add(1)
		if _, err := node.Write(op); err != nil {
			fmt.Fprintln(stderr, "pen service: could not forward an op:", err)
			return serviceFailed, true
		}
	}
}

// readCappedLine reads one line with its LF, at most limit bytes; io.EOF means the input ended (a partial last line is
// dropped).
func readCappedLine(r *bufio.Reader, limit int) ([]byte, error) {
	var out []byte
	for {
		b, err := r.ReadSlice('\n')
		out = append(out, b...)
		if len(out) > limit {
			return nil, fmt.Errorf("a line is over %d bytes", limit)
		}
		switch {
		case err == nil:
			return out, nil
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		case errors.Is(err, io.EOF):
			return nil, io.EOF
		default:
			return nil, err
		}
	}
}

// readKeyLine reads the 43-character base64url key and its LF, and nothing after it.
func readKeyLine(r *bufio.Reader) (string, error) {
	var line []byte
	for len(line) < 44 {
		c, err := r.ReadByte()
		if err != nil {
			return "", errors.New("stdin ended before the key line")
		}
		if c == '\n' {
			break
		}
		line = append(line, c)
	}
	k, err := base64.RawURLEncoding.Strict().DecodeString(string(line))
	if len(line) != 43 || err != nil || len(k) != 32 {
		return "", errors.New("the key line must be 32 bytes as 43 base64url characters and LF")
	}
	return string(line), nil
}
