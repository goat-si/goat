// Package state owns the node's directory: identity, config and the writer lock.
package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/goat-si/goat/apps/pen/internal/ident"
)

// Store is one state directory.
type Store struct{ Dir string }

// Dir is $PEN_HOME or ~/.pen.
func Dir() (string, error) {
	if d := os.Getenv("PEN_HOME"); d != "" {
		return filepath.Abs(d)
	}
	h, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(h, ".pen"), nil
}

// Open opens (and creates, private to this user) the state directory.
func Open() (*Store, error) {
	d, err := Dir()
	if err != nil {
		return nil, err
	}
	return OpenDir(d)
}

// OpenDir opens a specific directory and makes it private to this user: mode 0700, or on Windows a
// protected DACL with one ACE for this user that its files inherit.
func OpenDir(d string) (*Store, error) {
	if err := os.MkdirAll(d, 0o700); err != nil {
		return nil, err
	}
	if err := restrictDir(d); err != nil {
		return nil, err
	}
	return &Store{Dir: d}, nil
}

// Path joins a file name to the directory.
func (s *Store) Path(name string) string { return filepath.Join(s.Dir, name) }

// WriteAtomic writes via a temp file and rename.
func (s *Store) WriteAtomic(name string, data []byte, perm os.FileMode) error {
	f, err := os.CreateTemp(s.Dir, "."+name+".tmp*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	ok := false
	defer func() {
		if !ok {
			_ = os.Remove(tmp)
		}
	}()
	if err := f.Chmod(perm); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := Replace(tmp, s.Path(name)); err != nil {
		return err
	}
	ok = true
	return nil
}

// WriteJSON writes v as indented JSON atomically.
func (s *Store) WriteJSON(name string, v any, perm os.FileMode) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return s.WriteAtomic(name, append(b, '\n'), perm)
}

// ReadJSON reads name into v; it reports false when the file does not exist. It takes no lock, so a
// reader never waits on another; on Windows it retries the moment a concurrent replace refuses the open.
func (s *Store) ReadJSON(name string, v any) (bool, error) {
	b, err := readFile(s.Path(name))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := json.Unmarshal(b, v); err != nil {
		return false, fmt.Errorf("state: %s: %w", name, err)
	}
	return true, nil
}

// ErrLocked means another process holds the lock.
var ErrLocked = errors.New("state: locked by another process")

// Lock takes the exclusive writer lock on state.lock, waiting for it, and returns its release.
func (s *Store) Lock() (func(), error) {
	return lockPath(s.Path("state.lock"), true)
}

// TryLock takes an exclusive lock on path without waiting (ErrLocked when another process holds it).
// The lock lasts until the release or the process ends.
func TryLock(path string) (func(), error) { return lockPath(path, false) }

func lockPath(path string, wait bool) (func(), error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := lockFile(f, wait); err != nil {
		f.Close()
		return nil, err
	}
	return func() {
		unlockFile(f)
		f.Close()
	}, nil
}

type identityFile struct {
	SignSeed  string `json:"signSeed"`
	NoisePriv string `json:"noisePriv"`
}

// LoadIdentity reads identity.json; os.ErrNotExist when there is none.
func (s *Store) LoadIdentity() (*ident.Identity, error) {
	var f identityFile
	ok, err := s.ReadJSON("identity.json", &f)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, os.ErrNotExist
	}
	seed, err1 := ident.B64.DecodeString(f.SignSeed)
	np, err2 := ident.B64.DecodeString(f.NoisePriv)
	if err1 != nil || err2 != nil {
		return nil, errors.New("state: identity.json is corrupt")
	}
	return ident.FromSeeds(seed, np)
}

// EnsureIdentity loads the identity or creates one. created reports a new identity.
func (s *Store) EnsureIdentity() (id *ident.Identity, created bool, err error) {
	return s.EnsureIdentityClearing("")
}

// EnsureIdentityClearing is EnsureIdentity that first removes the file marker (unless ""), in the same
// hold of the state lock: pen up, pen join and pen login start a node again by clearing the left marker
// and making its identity in one step, so a pen leave that deletes a node's files only while the
// marker is present (FinishLeave, under the same lock) cannot delete the new node's.
func (s *Store) EnsureIdentityClearing(marker string) (id *ident.Identity, created bool, err error) {
	unlock, err := s.Lock()
	if err != nil {
		return nil, false, err
	}
	defer unlock()
	if marker != "" {
		if err := os.Remove(s.Path(marker)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, false, err
		}
	}
	return s.ensureIdentityLocked()
}

// ErrMarked is EnsureIdentityUnless's refusal: the marker is present.
var ErrMarked = errors.New("state: marker present")

// EnsureIdentityUnless is EnsureIdentity that refuses (ErrMarked) while marker exists, in the same hold of the
// state lock: pen identity makes a node's keys without starting it, so it must neither clear a pen leave's marker
// nor make keys that the resumed leave would delete.
func (s *Store) EnsureIdentityUnless(marker string) (id *ident.Identity, created bool, err error) {
	unlock, err := s.Lock()
	if err != nil {
		return nil, false, err
	}
	defer unlock()
	if _, err := os.Stat(s.Path(marker)); err == nil {
		return nil, false, ErrMarked
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, false, err
	}
	return s.ensureIdentityLocked()
}

func (s *Store) ensureIdentityLocked() (id *ident.Identity, created bool, err error) {
	id, err = s.LoadIdentity()
	if err == nil {
		return id, false, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, false, err
	}
	id, err = ident.Generate(nil)
	if err != nil {
		return nil, false, err
	}
	f := identityFile{SignSeed: ident.B64.EncodeToString(id.SignPriv.Seed()), NoisePriv: ident.B64.EncodeToString(id.NoisePriv)}
	if err := s.WriteJSON("identity.json", f, 0o600); err != nil {
		return nil, false, err
	}
	return id, true, nil
}

// Config is config.json. Relays is the relay list; Relay repeats the first one so binaries that
// know only one relay still start.
type Config struct {
	Relay  string   `json:"relay"`
	Relays []string `json:"relays,omitempty"`
	Name   string   `json:"name"`
	// DownloadRelay serves install.sh and the binaries (install.sh sets it); invites name it.
	DownloadRelay string `json:"downloadRelay,omitempty"`
}

// RelayList is the node's relays; a v1 config's single relay migrates to a one-element list.
func (c Config) RelayList() []string {
	if len(c.Relays) == 0 && c.Relay != "" {
		return []string{c.Relay}
	}
	return c.Relays
}

// SetRelays replaces the relay list.
func (c *Config) SetRelays(relays []string) {
	c.Relays = append([]string(nil), relays...)
	c.Relay = ""
	if len(relays) > 0 {
		c.Relay = relays[0]
	}
}

// LoadConfig reads config.json (zero value when absent).
func (s *Store) LoadConfig() (Config, error) {
	var c Config
	_, err := s.ReadJSON("config.json", &c)
	return c, err
}

// SaveConfig writes config.json with both relays and relay (the first one, for older binaries).
func (s *Store) SaveConfig(c Config) error {
	c.SetRelays(c.RelayList())
	return s.WriteJSON("config.json", c, 0o600)
}

// UpdateConfig changes config.json read to write under the state lock, so a writer in another
// process (the daemon, pen relay download) never replaces a field it did not change with an older
// value.
func (s *Store) UpdateConfig(f func(*Config)) error {
	unlock, err := s.Lock()
	if err != nil {
		return err
	}
	defer unlock()
	c, err := s.LoadConfig()
	if err != nil {
		return err
	}
	f(&c)
	return s.SaveConfig(c)
}
