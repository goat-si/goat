package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

// RunJoin joins the mesh an invite token names, then starts the daemon.
func RunJoin(args []string, stdout, stderr io.Writer) int {
	fs := newFlags("join", stderr)
	name := fs.String("name", "", "this node's name")
	noService := fs.Bool("no-service", false, "never install a systemd or launchd service")
	pos, err := parse(fs, args)
	if err != nil {
		return 2
	}
	if len(pos) != 1 {
		fmt.Fprintln(stderr, "usage: pen join <token> [--name N]")
		return 2
	}
	tok, err := mesh.ParseToken(pos[0])
	if err != nil {
		return fail(stderr, err)
	}
	st, err := openState()
	if err != nil {
		return fail(stderr, err)
	}
	if err := clearLeft(st); err != nil {
		return fail(stderr, err)
	}
	id, _, err := st.EnsureIdentity()
	if err != nil {
		return fail(stderr, err)
	}
	cfg, err := st.LoadConfig()
	if err != nil {
		return fail(stderr, err)
	}
	n := *name
	if n == "" {
		n = cfg.Name
	}
	if n == "" {
		n = defaultName()
	}
	if !ident.ValidName(n) {
		return fail(stderr, fmt.Errorf("invalid name %q", n))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	var ls daemon.LsReply
	if err := daemon.Call(st, daemon.Request{Op: "join", Token: tok.String(), Name: n}, &ls); err == nil {
		printMembers(stdout, ls)
		return 0
	} else if !errors.Is(err, daemon.ErrNotRunning) {
		return fail(stderr, err)
	}
	if err := joinOffline(ctx, st, id, tok, n); err != nil {
		return fail(stderr, err)
	}
	upArgs := []string{}
	if *noService {
		upArgs = append(upArgs, "--no-service")
	}
	if code := RunUp(upArgs, io.Discard, stderr); code != 0 {
		return code
	}
	if err := daemon.Call(st, daemon.Request{Op: "ls"}, &ls); err != nil {
		return fail(stderr, err)
	}
	printMembers(stdout, ls)
	return 0
}

// joinOffline joins without a running daemon and saves the mesh and the token's relay.
func joinOffline(ctx context.Context, st *state.Store, id *ident.Identity, tok mesh.Token, name string) error {
	if cur, err := mesh.Load(st); err == nil {
		if n := len(cur.View().Members); n > 1 {
			return fmt.Errorf("this node is already in a mesh with %d members; pen leave first", n)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	s, err := daemon.Join(ctx, st, id, tok, name)
	if err != nil {
		return err
	}
	if err := s.Save(); err != nil {
		return err
	}
	os.Remove(st.Path("offers.json"))
	old, err := st.LoadConfig()
	if err != nil {
		return err
	}
	c := state.Config{Name: name, DownloadRelay: old.DownloadRelay}
	c.SetRelays(tok.Relays)
	return st.SaveConfig(c)
}
