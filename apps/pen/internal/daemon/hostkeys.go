package daemon

import (
	"context"
	"os"
	"os/user"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"github.com/goat-si/goat/apps/pen/internal/mesh"
)

// DefaultKnownHosts is ~/.ssh/pen/known_hosts.
func DefaultKnownHosts() (string, error) {
	h, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(h, ".ssh", "pen", "known_hosts"), nil
}

// ReadHostKeys returns the sshd public keys matching glob as sorted "type base64" lines (at most 8).
func ReadHostKeys(glob string) []string {
	paths, _ := filepath.Glob(glob)
	var keys []string
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		f := strings.Fields(string(b))
		if len(f) >= 2 {
			keys = append(keys, f[0]+" "+f[1])
		}
	}
	sort.Strings(keys)
	keys = slices.Compact(keys)
	if len(keys) > 8 {
		keys = keys[:8]
	}
	return keys
}

func (d *Daemon) hostKeysLoop(ctx context.Context) {
	if d.opt.HostKeyGlob == "none" {
		return
	}
	d.checkHostKeys(ctx)
	d.every(ctx, d.opt.HostKeysEvery, func() { d.checkHostKeys(ctx) })
}

// LoginUser is this process's OS login name when it is a valid hostkeys user, else "".
func LoginUser() string {
	u, err := user.Current()
	if err != nil || !mesh.ValidUser(u.Username) {
		return ""
	}
	return u.Username
}

// checkHostKeys signs a hostkeys record when the local sshd keys or the login user differ from the
// latest one.
func (d *Daemon) checkHostKeys(ctx context.Context) {
	keys := ReadHostKeys(d.opt.HostKeyGlob)
	self, ok := d.view().Members[d.selfKey()]
	if !ok || slices.Equal(self.HostKeys, keys) && self.User == d.sshUser {
		return
	}
	if _, err := d.mesh().Append(d.id, mesh.TypeHostKeys, d.now().UnixMilli(), mesh.Fields{Keys: keys, User: d.sshUser}); err != nil {
		d.opt.Logf("hostkeys: %v", err)
		return
	}
	d.viewChanged()
	d.pushAll(ctx)
}

// writeKnownHosts writes pen-<name>,pen-<nodeId> lines for every member's host keys. Writers are
// serialized and each reads the view under the lock, so the last write is always the newest view.
func (d *Daemon) writeKnownHosts() {
	d.khMu.Lock()
	defer d.khMu.Unlock()
	v := d.view()
	if d.opt.OnView != nil {
		defer func() {
			if err := d.opt.OnView(v); err != nil {
				d.opt.Logf("ssh config: %v", err)
			}
		}()
	}
	if d.opt.KnownHosts == "none" {
		return
	}
	var b strings.Builder
	for _, m := range v.SortedMembers() {
		for _, k := range m.HostKeys {
			b.WriteString("pen-" + m.Name + ",pen-" + m.NodeID + " " + k + "\n")
		}
	}
	dir := filepath.Dir(d.opt.KnownHosts)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		d.opt.Logf("known_hosts: %v", err)
		return
	}
	tmp, err := os.CreateTemp(dir, ".known_hosts.tmp*")
	if err != nil {
		d.opt.Logf("known_hosts: %v", err)
		return
	}
	_, err = tmp.WriteString(b.String())
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp.Name(), d.opt.KnownHosts)
	}
	if err != nil {
		os.Remove(tmp.Name())
		d.opt.Logf("known_hosts: %v", err)
	}
}
