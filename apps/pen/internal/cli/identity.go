package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

// IdentityReply is what pen identity --json prints.
type IdentityReply struct {
	NodeID   string `json:"nodeId"`
	SignPub  string `json:"signPub"`
	NoisePub string `json:"noisePub"`
}

// RunIdentity makes this machine's node keys when there are none and prints them, without joining a mesh, so a
// program can have an invite bound to them (contract "Bound invites") before pen join runs. pen join keeps them.
func RunIdentity(args []string, stdout, stderr io.Writer) int {
	fs := newFlags("identity", stderr)
	asJSON := fs.Bool("json", false, "print {nodeId, signPub, noisePub} as one JSON line")
	pos, err := parse(fs, args)
	if err != nil {
		return 2
	}
	if len(pos) != 0 {
		fmt.Fprintln(stderr, "usage: pen identity [--json]")
		return 2
	}
	st, err := openState()
	if err != nil {
		return fail(stderr, err)
	}
	id, _, err := st.EnsureIdentityUnless(daemon.LeftMarker)
	if errors.Is(err, state.ErrMarked) {
		return fail(stderr, errors.New("a pen leave has not finished on this machine; run pen leave again first"))
	}
	if err != nil {
		return fail(stderr, err)
	}
	r := IdentityReply{NodeID: id.NodeID(), SignPub: ident.B64.EncodeToString(id.SignPub), NoisePub: ident.B64.EncodeToString(id.NoisePub)}
	if *asJSON {
		if err := json.NewEncoder(stdout).Encode(r); err != nil {
			return fail(stderr, err)
		}
		return 0
	}
	fmt.Fprintf(stdout, "nodeId   %s\nsignPub  %s\nnoisePub %s\n", r.NodeID, r.SignPub, r.NoisePub)
	return 0
}
