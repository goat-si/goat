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
	stdinDone := make(chan struct{})
	if untilStdinCloses {
		stdin := Stdin
		go func() {
			io.Copy(io.Discard, stdin)
			close(stdinDone)
			cl.Close()
		}()
	}
	reader := bufio.NewReaderSize(cl.Rest(), 1<<20)
	for {
		line, err := reader.ReadSlice('\n')
		if errors.Is(err, bufio.ErrBufferFull) {
			return fail(stderr, errors.New("a snapshot line is longer than pen ls prints"))
		}
		if err != nil {
			select {
			case <-stdinDone:
				return 0
			default:
				return fail(stderr, errors.New("the daemon closed the watch"))
			}
		}
		n, err := stdout.Write(line)
		if err != nil {
			return fail(stderr, err)
		}
		if n != len(line) {
			return fail(stderr, io.ErrShortWrite)
		}
	}
}
