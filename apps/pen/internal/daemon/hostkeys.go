package daemon

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"os/user"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

// DefaultKnownHosts is ~/.ssh/pen/known_hosts.
func DefaultKnownHosts() (string, error) {
	h, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(h, ".ssh", "pen", "known_hosts"), nil
}

// ReadHostKeys returns the sshd public keys matching glob as sorted "type base64" lines (at most 8),
// and, when it could not read the key folder or some key files, what failed and how to fix it.
func ReadHostKeys(glob string) (keys []string, problem string) {
	const effect = ": those keys are not published, so ssh pen-<name> from other members can fail host key checking; "
	paths, _ := filepath.Glob(glob)
	if len(paths) == 0 {
		// Glob hides a folder it cannot list; a missing folder only means no sshd here.
		dir := filepath.Dir(glob)
		if _, err := os.ReadDir(dir); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return nil, "cannot list " + dir + " (" + pathCause(err) + ")" + effect + hostKeysDirFix(dir)
		}
	}
	var unreadable, failed []string
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			unreadable = append(unreadable, p+" ("+pathCause(err)+")")
			failed = append(failed, p)
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
	if len(unreadable) > 0 {
		problem = "cannot read " + strings.Join(unreadable, "; ") + effect + hostKeysFix(failed)
	}
	return keys, problem
}

// pathCause is err without the operation and path a *fs.PathError repeats.
func pathCause(err error) string {
	var pe *fs.PathError
	if errors.As(err, &pe) {
		return pe.Err.Error()
	}
	return err.Error()
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
	if err != nil {
		return ""
	}
	name := loginName(u.Username)
	if !mesh.ValidUser(name) {
		return ""
	}
	return name
}

// localAccountName is the ssh login of a Windows account (COMPUTER\name): the name, lowercased, when
// the account belongs to this computer; "" for a domain account, whose login would need name@domain,
// which a hostkeys user cannot carry.
func localAccountName(account, computer string) string {
	i := strings.LastIndex(account, `\`)
	if i < 0 || !strings.EqualFold(account[:i], computer) {
		return ""
	}
	return strings.ToLower(account[i+1:])
}

// checkHostKeys signs a hostkeys record when the local sshd keys or the login user differ from the
// latest one.
func (d *Daemon) checkHostKeys(ctx context.Context) {
	keys, problem := ReadHostKeys(d.opt.HostKeyGlob)
	d.noteHostKeys(problem)
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

// noteHostKeys keeps the host key problem for pen ls and logs it when it changes. Pen never asks the
// local sshd for its keys instead: another local user could answer on that port.
func (d *Daemon) noteHostKeys(msg string) {
	d.mu.Lock()
	changed := msg != d.hostKeysErr
	d.hostKeysErr = msg
	d.mu.Unlock()
	if changed && msg != "" {
		d.opt.Logf("hostkeys: %s", msg)
	}
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
		err = state.Replace(tmp.Name(), d.opt.KnownHosts)
	}
	if err != nil {
		os.Remove(tmp.Name())
		d.opt.Logf("known_hosts: %v", err)
	}
}
