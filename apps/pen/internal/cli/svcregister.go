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
	// The node answers every op once, in order; events (invite-burned, invite-exhausted) are not answers. Counting
	// both sides lets the end of stdin succeed only once every forwarded op was answered.
	var released, noHalfClose atomic.Bool
	var forwarded, answered atomic.Int64
	allAnswered := func() bool { return answered.Load() == forwarded.Load() }
	ended := make(chan int, 3)
	go func() {
		for {
			op, err := readCappedLine(stdin, serviceOpCap)
			if errors.Is(err, io.EOF) {
				// Released: the node answers what it was sent, then ends the registration and closes.
				released.Store(true)
				if cl.CloseWrite() != nil {
					// Without a half-close the node cannot end the registration for us: stop at the last answer.
					noHalfClose.Store(true)
					if allAnswered() {
						ended <- serviceReleased
					}
				}
				return
			}
			if err != nil {
				fmt.Fprintln(stderr, "pen service:", err)
				ended <- serviceFailed
				return
			}
			forwarded.Add(1)
			if _, err := cl.Write(op); err != nil {
				return
			}
		}
	}()
	go func() {
		node := bufio.NewReaderSize(cl.Rest(), 4096)
		for {
			b, err := readCappedLine(node, serviceAnswerCap)
			if err != nil {
				if released.Load() && allAnswered() {
					ended <- serviceReleased
					return
				}
				if released.Load() {
					fmt.Fprintf(stderr, "pen service: the pen daemon closed the registration of %s before answering %d forwarded op(s)\n",
						name, forwarded.Load()-answered.Load())
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
				answered.Add(1)
				if released.Load() && noHalfClose.Load() && allAnswered() {
					ended <- serviceReleased
					return
				}
			}
		}
	}()
	return <-ended
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
