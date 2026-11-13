package cli

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
)

type snapshotResult struct {
	request string
	err     error
}

func snapshotDaemon(t *testing.T, serve func(net.Conn) error) <-chan snapshotResult {
	t.Helper()
	st := tmpStore(t)
	t.Setenv("PEN_HOME", st.Dir)
	ln, err := net.Listen("unix", daemon.SocketPath(st))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	result := make(chan snapshotResult, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			result <- snapshotResult{err: err}
			return
		}
		defer c.Close()
		line, err := bufio.NewReader(c).ReadString('\n')
		if err == nil {
			err = serve(c)
		}
		result <- snapshotResult{request: line, err: err}
	}()
	return result
}

type snapshotWrites struct{ lines []string }

func (w *snapshotWrites) Write(p []byte) (int, error) {
	w.lines = append(w.lines, string(p))
	return len(p), nil
}

type forbiddenSnapshotStdin struct{ t *testing.T }

func (r forbiddenSnapshotStdin) Read([]byte) (int, error) {
	r.t.Error("snapshot read stdin without the flag")
	return 0, io.EOF
}

func TestLsSnapshotCopiesLinesAndRefusalWithoutAnLsRequest(t *testing.T) {
	lines := []string{" { \"z\":1, \"a\" : 2 } \n", "{\"error\":\"too many snapshot watchers\"}\n"}
	result := snapshotDaemon(t, func(c net.Conn) error {
		_, err := io.WriteString(c, strings.Join(lines, ""))
		return err
	})
	old := Stdin
	Stdin = forbiddenSnapshotStdin{t}
	defer func() { Stdin = old }()
	var out snapshotWrites
	var stderr bytes.Buffer
	code := RunLs([]string{"--watch", "--snapshot"}, &out, &stderr)
	got := <-result
	if got.err != nil || got.request != "{\"op\":\"watch.snapshot\"}\n" {
		t.Fatalf("request %q, daemon error %v", got.request, got.err)
	}
	if fmt.Sprint(out.lines) != fmt.Sprint(lines) || len(out.lines) != len(lines) {
		t.Fatalf("writes %#v, want %#v", out.lines, lines)
	}
	if code != 1 || !strings.Contains(stderr.String(), "the daemon closed the watch") {
		t.Fatalf("exit %d stderr %q", code, stderr.String())
	}
}

func TestLsSnapshotRejectsAnOverlongLine(t *testing.T) {
	result := snapshotDaemon(t, func(c net.Conn) error {
		_, err := io.WriteString(c, strings.Repeat("x", (1<<20)+1))
		return err
	})
	var out, stderr bytes.Buffer
	code := RunLs([]string{"--watch", "--snapshot"}, &out, &stderr)
	<-result
	if code != 1 || out.Len() != 0 || !strings.Contains(stderr.String(), "pen: a snapshot line is longer than pen ls prints") {
		t.Fatalf("exit %d, stdout length %d, stderr %q", code, out.Len(), stderr.String())
	}
}

func TestLsSnapshotStdinClosureClosesTheDaemonConnection(t *testing.T) {
	result := snapshotDaemon(t, func(c net.Conn) error {
		if _, err := io.WriteString(c, "first\n"); err != nil {
			return err
		}
		_, err := io.Copy(io.Discard, c)
		return err
	})
	stdin, input, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	defer input.Close()
	old := Stdin
	Stdin = stdin
	defer func() { Stdin = old }()
	out, output := io.Pipe()
	defer out.Close()
	defer output.Close()
	var stderr bytes.Buffer
	code := make(chan int, 1)
	go func() { code <- RunLs([]string{"--watch", "--snapshot", "--until-stdin-closes"}, output, &stderr) }()
	line, err := bufio.NewReader(out).ReadString('\n')
	if err != nil || line != "first\n" {
		t.Fatalf("line %q, error %v", line, err)
	}
	input.Close()
	if got := <-code; got != 0 || stderr.Len() != 0 {
		t.Fatalf("exit %d, stderr %q", got, stderr.String())
	}
	if got := <-result; got.err != nil {
		t.Fatalf("daemon: %v", got.err)
	}
}

func TestLsSnapshotDevNullStdinEndsTheWatch(t *testing.T) {
	result := snapshotDaemon(t, func(c net.Conn) error { _, err := io.Copy(io.Discard, c); return err })
	stdin, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	old := Stdin
	Stdin = stdin
	defer func() { Stdin = old }()
	var out, stderr bytes.Buffer
	code := RunLs([]string{"--watch", "--snapshot", "--until-stdin-closes"}, &out, &stderr)
	if code != 0 || stderr.Len() != 0 {
		t.Fatalf("exit %d, stderr %q", code, stderr.String())
	}
	if got := <-result; got.err != nil {
		t.Fatalf("daemon: %v", got.err)
	}
}

func TestLsSnapshotRejectsInvalidFlagCombinations(t *testing.T) {
	t.Setenv("PEN_HOME", t.TempDir())
	for _, args := range [][]string{
		{"--snapshot"}, {"--watch", "--snapshot", "--json"},
		{"--watch", "--snapshot", "--until-revoked", "x"}, {"--until-stdin-closes"},
	} {
		var out, stderr bytes.Buffer
		if code := RunLs(args, &out, &stderr); code != 2 || !strings.Contains(strings.ToLower(stderr.String()), "usage") {
			t.Errorf("args %v: exit %d stderr %q", args, code, stderr.String())
		}
	}
}

func TestLsSnapshotReportsDaemonNotRunning(t *testing.T) {
	t.Setenv("PEN_HOME", t.TempDir())
	var out, stderr bytes.Buffer
	if code := RunLs([]string{"--watch", "--snapshot"}, &out, &stderr); code != 1 || !strings.Contains(stderr.String(), "the pen daemon is not running") {
		t.Fatalf("exit %d stderr %q", code, stderr.String())
	}
}

type failedSnapshotWriter struct{}

func (failedSnapshotWriter) Write([]byte) (int, error) { return 0, errors.New("write failed") }

func TestLsSnapshotFailsWhenStdoutFails(t *testing.T) {
	result := snapshotDaemon(t, func(c net.Conn) error { _, err := io.WriteString(c, "line\n"); return err })
	var stderr bytes.Buffer
	if code := RunLs([]string{"--watch", "--snapshot"}, failedSnapshotWriter{}, &stderr); code != 1 {
		t.Fatalf("exit %d", code)
	}
	<-result
}

func TestLsSnapshotAcceptsALineAtTheLimit(t *testing.T) {
	line := strings.Repeat("x", (1<<20)-1) + "\n"
	result := snapshotDaemon(t, func(c net.Conn) error { _, err := io.WriteString(c, line); return err })
	var out snapshotWrites
	var stderr bytes.Buffer
	code := RunLs([]string{"--watch", "--snapshot"}, &out, &stderr)
	got := <-result
	if got.err != nil || code != 1 || len(out.lines) != 1 || out.lines[0] != line || !strings.Contains(stderr.String(), "the daemon closed the watch") {
		t.Fatalf("exit %d, writes %d, daemon error %v, stderr %q", code, len(out.lines), got.err, stderr.String())
	}
}
