package daemon

import (
	"context"
	"errors"
	"fmt"
	"os"
	"slices"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
)

func (d *Daemon) selfKey() string { return ident.B64.EncodeToString(d.id.SignPub) }

// revoke signs a revoke of subject (a member's signPub) and pushes it.
func (d *Daemon) revoke(ctx context.Context, subject string, compromised bool) ([]PushResult, error) {
	v := d.view()
	if _, ok := v.Members[subject]; !ok {
		return nil, errors.New("not a current member")
	}
	if subject == d.selfKey() {
		return nil, errors.New("to remove this node, use pen leave")
	}
	if _, err := d.mesh().Append(d.id, mesh.TypeRevoke, d.now().UnixMilli(), mesh.Fields{Subjects: []string{subject}, Compromised: compromised}); err != nil {
		return nil, err
	}
	d.viewChanged()
	return d.pushAll(ctx), nil
}

// leave revokes this node's own key, pushes the revoke to the members it had, and deletes its keys.
// The caller stops the daemon after replying.
func (d *Daemon) leave(ctx context.Context) ([]PushResult, error) {
	v := d.view()
	before := v.SortedMembers()
	// A retried leave finds its own revoke already signed and only pushes it again.
	if _, revoked := v.Revoked[d.selfKey()]; !revoked {
		if _, err := d.mesh().Append(d.id, mesh.TypeRevoke, d.now().UnixMilli(), mesh.Fields{Subjects: []string{d.selfKey()}}); err != nil {
			return nil, err
		}
		d.viewChanged()
	}
	res := d.pushTo(ctx, before)
	taken := 0
	for i := range res {
		// A member that refuses this key already holds a revoke of it (another push carried it).
		if res[i].Result == "refused" {
			res[i].Result = "taken"
		}
		if res[i].Result == "taken" {
			taken++
		}
	}
	if len(res) > 0 && taken == 0 {
		// Deleting the keys now would leave the mesh counting this node as a member for good.
		return res, errors.New("no member took the leave; this node keeps running and pushes it when a member's uplink returns or at its 10-minute sync, or run pen leave again")
	}
	d.stopUplinks("left")
	unlock, err := d.st.Lock()
	if err != nil {
		return res, err
	}
	defer unlock()
	// Written before the keys go, so a service manager restarting pen up --foreground finds it.
	if err := d.st.WriteAtomic(LeftMarker, nil, 0o600); err != nil {
		return res, err
	}
	for _, f := range []string{"identity.json", "mesh.json", "offers.json"} {
		if err := os.Remove(d.st.Path(f)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return res, err
		}
	}
	return res, nil
}

// join replaces a solo mesh with the one tok invites to.
func (d *Daemon) join(ctx context.Context, token, name string) error {
	tok, err := mesh.ParseToken(token)
	if err != nil {
		return err
	}
	v := d.view()
	if len(v.Members) > 1 {
		return fmt.Errorf("this node is already in a mesh with %d members; pen leave first", len(v.Members))
	}
	if name == "" {
		name = v.Members[d.selfKey()].Name
	}
	if !ident.ValidName(name) {
		return fmt.Errorf("invalid name %q", name)
	}
	store, err := Join(ctx, d.st, d.id, tok, name)
	if err != nil {
		return err
	}
	if err := store.Save(); err != nil {
		return err
	}
	// The old mesh's invites go; new ones persist in offers.json as before.
	if err := os.Remove(d.st.Path("offers.json")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	invites, err := mesh.LoadInvites(d.st)
	if err != nil {
		return err
	}
	d.meshMu.Lock()
	d.store = store
	d.invites = invites
	d.meshMu.Unlock()
	// A save of the old set that was already running must not be the last write.
	if err := store.Save(); err != nil {
		return err
	}
	d.cfgMu.Lock()
	changed := !slices.Equal(d.cfg.RelayList(), tok.Relays)
	d.cfg.SetRelays(tok.Relays)
	d.cfg.Name = name
	cfg := d.cfg
	d.cfgMu.Unlock()
	if err := d.st.SaveConfig(cfg); err != nil {
		return err
	}
	if changed {
		d.startUplinks()
	}
	d.viewChanged()
	return nil
}

// rename signs a name record for this node.
func (d *Daemon) rename(ctx context.Context, name string) error {
	if !ident.ValidName(name) {
		return fmt.Errorf("invalid name %q", name)
	}
	if d.view().Members[d.selfKey()].Name == name {
		return nil
	}
	if _, err := d.mesh().Append(d.id, mesh.TypeName, d.now().UnixMilli(), mesh.Fields{Subject: d.selfKey(), Name: name}); err != nil {
		return err
	}
	d.cfgMu.Lock()
	d.cfg.Name = name
	cfg := d.cfg
	d.cfgMu.Unlock()
	if err := d.st.SaveConfig(cfg); err != nil {
		return err
	}
	d.viewChanged()
	d.spawn(func() { d.pushAll(d.runCtx) })
	return nil
}
