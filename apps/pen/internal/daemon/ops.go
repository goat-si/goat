package daemon

import (
	"context"
	"errors"
	"fmt"
	"github.com/goat-si/goat/apps/pen/internal/state"
	"os"
	"slices"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/login"
	"github.com/goat-si/goat/apps/pen/internal/mesh"
)

func (d *Daemon) selfKey() string { return ident.B64.EncodeToString(d.id.SignPub) }

// revoke signs a revoke of subject (a member's signPub) and pushes it. A key already revoked can
// still be revoked as compromised: a machine found stolen after it left must lose the keys it
// admitted and the records it signed.
func (d *Daemon) revoke(ctx context.Context, subject string, compromised bool) ([]PushResult, error) {
	v := d.view()
	if _, ok := v.Members[subject]; !ok {
		if _, was := v.Revoked[subject]; !was || !compromised {
			return nil, errors.New("not a current member (a revoked one can only be revoked again with --compromised)")
		}
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
	// A leave that wrote the left marker but could not delete every file only deletes what is left.
	if _, err := os.Stat(d.st.Path(LeftMarker)); err == nil {
		return nil, FinishLeave(d.st)
	}
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
	// The registry stops offering this node; the daemon stops right after, so this runs in line.
	if b, ok := binding(d.view()); ok {
		fctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		if err := login.New(b.LoginURL).Forget(fctx, d.id, d.nodeID, d.now()); err != nil {
			d.opt.Logf("login forget on leave: %v", err)
		}
		cancel()
	}
	unlock, err := d.st.Lock()
	if err != nil {
		return res, err
	}
	defer unlock()
	// Written before the keys go, so a service manager restarting pen up --foreground finds it.
	if err := d.st.WriteAtomic(LeftMarker, nil, 0o600); err != nil {
		return res, err
	}
	return res, removeNodeFiles(d.st)
}

// FinishLeave deletes, under the state lock, what a leave that wrote the left marker could not: the
// node's keys, its mesh and its invites. pen leave runs it when it finds the marker and no daemon. It
// looks at the marker again under the lock and deletes nothing without it (ErrNotLeaving): pen up,
// pen join and pen login clear the marker and make a new identity in one hold of the same lock.
func FinishLeave(st *state.Store) error {
	unlock, err := st.Lock()
	if err != nil {
		return err
	}
	defer unlock()
	if _, err := os.Stat(st.Path(LeftMarker)); errors.Is(err, os.ErrNotExist) {
		return ErrNotLeaving
	} else if err != nil {
		return err
	}
	return removeNodeFiles(st)
}

// ErrNotLeaving means the left marker is gone: a node was started again here, and nothing is deleted.
var ErrNotLeaving = errors.New("this node is not leaving its mesh")

// FinishLeaveOrEmpty decides a resumed pen leave in one hold of the state lock: with the left marker it
// finishes the deletion (left is true); with no marker and no identity nothing of a node is here; with an
// identity and no marker a node was started here meanwhile (ErrNotLeaving).
func FinishLeaveOrEmpty(st *state.Store) (left bool, err error) {
	unlock, err := st.Lock()
	if err != nil {
		return false, err
	}
	defer unlock()
	if _, err := os.Stat(st.Path(LeftMarker)); err == nil {
		return true, removeNodeFiles(st)
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if _, err := st.LoadIdentity(); errors.Is(err, os.ErrNotExist) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	return false, ErrNotLeaving
}

// removeNodeFiles deletes the node's files; the caller holds the state lock. An error names the file:
// the leave is done in the mesh, but this machine still holds it.
func removeNodeFiles(st *state.Store) error {
	for _, f := range []string{"identity.json", "mesh.json", "offers.json"} {
		if err := os.Remove(st.Path(f)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("this node left its mesh, but %s could not be deleted (%v); run pen leave again", st.Path(f), err)
		}
	}
	return nil
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
	return d.replaceMesh(store, tok.Relays, name)
}

// JoinedFile is where pen login leaves a mesh it joined for a running daemon to adopt.
const JoinedFile = "joined.json"

// adopt replaces a solo mesh with the set pen login joined (joined.json).
func (d *Daemon) adopt(ctx context.Context) error {
	store, err := mesh.LoadFile(d.st, JoinedFile)
	if errors.Is(err, os.ErrNotExist) {
		return errors.New("no joined mesh to adopt")
	}
	if err != nil {
		return err
	}
	store.SetSelf(d.selfKey())
	self, ok := store.View().Members[d.selfKey()]
	if !ok {
		return errors.New("the joined mesh does not make this node a member")
	}
	if cur := d.view(); cur.MeshID != store.MeshID && len(cur.Members) > 1 {
		return fmt.Errorf("this node is already in a mesh with %d members; pen leave first", len(cur.Members))
	}
	if err := d.replaceMesh(store, nil, self.Name); err != nil {
		return err
	}
	os.Remove(d.st.Path(JoinedFile))
	d.spawn(func() { d.pushAll(d.runCtx) })
	return nil
}

// replaceMesh makes store this node's mesh; relays (when set) replace the relay list.
func (d *Daemon) replaceMesh(store *mesh.Store, relays []string, name string) error {
	store.Adopt()
	if err := store.Save(); err != nil {
		return err
	}
	// mesh.json now refuses a save of the old set (another mesh), and the old set stops writing,
	// so a save of it that was already running cannot be the last write.
	if old := d.mesh(); old != nil && old != store {
		old.Retire()
	}
	// The old mesh's invites go; new ones persist in offers.json as before. The old book is retired
	// first, so a prune or invite still holding it cannot write them back.
	if old := d.inviteBook(); old != nil {
		old.Retire()
	}
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
	d.cfgMu.Lock()
	changed := relays != nil && !slices.Equal(d.cfg.RelayList(), relays)
	if changed {
		d.cfg.SetRelays(relays)
	}
	d.cfg.Name = name
	d.cfgMu.Unlock()
	if err := d.saveConfig(); err != nil {
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
	d.cfgMu.Unlock()
	if err := d.saveConfig(); err != nil {
		return err
	}
	d.viewChanged()
	d.spawn(func() { d.pushAll(d.runCtx) })
	return nil
}

// saveConfig writes the daemon's current config, keeping the download relay pen relay download
// may have set on disk since the daemon loaded it. One save at a time runs from its snapshot to
// its write, so an older snapshot never replaces a newer one.
func (d *Daemon) saveConfig() error {
	d.cfgSave.Lock()
	defer d.cfgSave.Unlock()
	d.cfgMu.Lock()
	cfg := d.cfg
	d.cfgMu.Unlock()
	return d.st.UpdateConfig(func(disk *state.Config) {
		dl := disk.DownloadRelay
		*disk = cfg
		if dl != "" {
			disk.DownloadRelay = dl
		}
	})
}
