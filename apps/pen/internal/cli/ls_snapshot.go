package cli

import (
	"bufio"
	"errors"
	"io"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
)

func runLsSnapshot(stdout, stderr io.Writer, untilStdinCloses bool) int {
	st, err := openState()
	if err != nil {
		return fail(stderr, err)
	}
	cl, err := daemon.Dial(st)
	if err != nil {
		return fail(stderr, err)
	}
	defer cl.Close()
	if err := cl.Send(daemon.Request{Op: "watch.snapshot"}); err != nil {
		return fail(stderr, err)
	}
	// Without the flag stdinDone stays nil, so it never ends the watch.
	var stdinDone chan struct{}
	if untilStdinCloses {
		stdinDone = make(chan struct{})
		stdin := Stdin
		go func() {
			io.Copy(io.Discard, stdin)
			close(stdinDone)
			cl.Close()
		}()
	}
	// The copy runs apart from this wait: a parent that stops reading stdout leaves a write
	// blocked, and closing stdin must still end pen ls.
	copied := make(chan error, 1)
	go func() { copied <- copySnapshots(cl.Rest(), stdout) }()
	select {
	case err := <-copied:
		select {
		case <-stdinDone:
			return 0
		default:
			return fail(stderr, err)
		}
	case <-stdinDone:
		return 0
	}
}

// copySnapshots copies whole lines until the watch or stdout fails; it always returns an error.
func copySnapshots(rest io.Reader, stdout io.Writer) error {
	reader := bufio.NewReaderSize(rest, 1<<20)
	for {
		line, err := reader.ReadSlice('\n')
		if errors.Is(err, bufio.ErrBufferFull) {
			return errors.New("a snapshot line is longer than pen ls prints")
		}
		if err != nil {
			return errors.New("the daemon closed the watch")
		}
		n, err := stdout.Write(line)
		if err != nil {
			return err
		}
		if n != len(line) {
			return io.ErrShortWrite
		}
	}
}
