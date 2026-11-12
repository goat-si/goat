// Package cli implements the pen verbs.
package cli

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

// Stdin is what pipe reads (a variable so tests can feed it).
var Stdin io.Reader = os.Stdin

// Version is set by main.
var Version = "dev"

// ServiceUnit, LaunchdPlist and TaskXML are the service templates main embeds.
var ServiceUnit, LaunchdPlist, TaskXML string

func fail(stderr io.Writer, err error) int {
	fmt.Fprintln(stderr, "pen:", err)
	return 1
}

// Bounds on what pen up, pen down and pen leave wait for, so a daemon or service manager that stops
// answering cannot hold them (or the Windows task turn they may hold): a status or stop request on the
// control socket, an operation that may reach other members (leave, rename, reconnect), and one run of
// schtasks, systemctl or launchctl. probeTimeout is a variable for tests.
var probeTimeout = 2 * time.Second

// leaveTimeout is how long pen leave waits for the daemon's leave (a variable for tests).
var leaveTimeout = opTimeout

const (
	opTimeout      = time.Minute
	commandTimeout = 15 * time.Second
)

func newFlags(name string, stderr io.Writer) *flag.FlagSet {
	fs := flag.NewFlagSet("pen "+name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	return fs
}

// parse parses flags that may come before or after positional arguments.
func parse(fs *flag.FlagSet, args []string) ([]string, error) {
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		args = fs.Args()
		if len(args) == 0 {
			return pos, nil
		}
		if args[0] == "--" {
			return append(pos, args[1:]...), nil
		}
		pos = append(pos, args[0])
		args = args[1:]
	}
}

func openState() (*state.Store, error) { return state.Open() }

// defaultName derives a node name from the host name.
func defaultName() string {
	h, _ := os.Hostname()
	h = strings.ToLower(strings.TrimSuffix(strings.ToLower(h), ".local"))
	var b strings.Builder
	for _, c := range h {
		switch {
		case c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.':
			b.WriteRune(c)
		default:
			b.WriteRune('-')
		}
	}
	n := strings.TrimLeft(b.String(), "-_.")
	if len(n) > 32 {
		n = n[:32]
	}
	if !ident.ValidName(n) {
		return "node"
	}
	return n
}

// daemonOptions builds the daemon options from the environment.
func daemonOptions(st *state.Store) daemon.Options {
	// PEN_SSH_USER overrides the published SSH login name; "none" publishes none.
	opt := daemon.Options{Store: st, HostKeyGlob: os.Getenv("PEN_HOSTKEYS"), SSHUser: os.Getenv("PEN_SSH_USER")}
	if d := os.Getenv("PEN_SSH_DIR"); d != "" {
		opt.KnownHosts = filepath.Join(d, "known_hosts")
	}
	opt.OnView = refreshSSHConfig
	return opt
}

func knownHostsPath() string {
	if d := os.Getenv("PEN_SSH_DIR"); d != "" {
		return filepath.Join(d, "known_hosts")
	}
	p, _ := daemon.DefaultKnownHosts()
	return p
}

// localView reads the mesh view from disk (no daemon needed).
func localView(st *state.Store) (*mesh.View, error) {
	s, err := mesh.Load(st)
	if errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("no mesh here yet; run pen login, pen join <token>, or pen up")
	}
	if err != nil {
		return nil, err
	}
	return s.View(), nil
}

func short(nodeID string) string {
	if len(nodeID) > 8 {
		return nodeID[:8]
	}
	return nodeID
}
