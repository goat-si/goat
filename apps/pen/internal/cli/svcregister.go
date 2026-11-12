package cli

import (
	"bufio"
	"encoding/base64"
	"errors"
	"fmt"
	"io"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
)

// Exit codes of pen service register (contract "Registration").
const (
	serviceReleased   = 0 // stdin ended: the program let the registration go
	serviceDaemonGone = 1
	serviceFailed     = 2
	serviceReplaced   = 3
)

// RunService runs "pen service register <name> --port <P>", the child a program keeps for as long as it
// serves name. The key comes as one line on stdin, never as an argument, a variable or a file.
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
	stdin := bufio.NewReaderSize(Stdin, 64)
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
	released := make(chan struct{})
	go func() {
		io.Copy(io.Discard, stdin)
		close(released)
	}()
	ended := make(chan int, 1)
	go func() {
		var notice struct{ T string }
		if err := cl.Next(&notice); err == nil && notice.T == "replaced" {
			fmt.Fprintf(stderr, "pen service: %s was replaced by a newer registration\n", name)
			ended <- serviceReplaced
			return
		}
		fmt.Fprintf(stderr, "pen service: the pen daemon closed the registration of %s\n", name)
		ended <- serviceDaemonGone
	}()
	select {
	case <-released:
		return serviceReleased
	case code := <-ended:
		return code
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
