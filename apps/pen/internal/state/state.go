// Package state owns the node's directory: identity, config and the writer lock.
package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"

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

// Open opens (and creates, 0700) the state directory.
func Open() (*Store, error) {
	d, err := Dir()
	if err != nil {
		return nil, err
	}
	return OpenDir(d)
}

// OpenDir opens a specific directory.
func OpenDir(d string) (*Store, error) {
	if err := os.MkdirAll(d, 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(d, 0o700); err != nil {
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
	if err := os.Rename(tmp, s.Path(name)); err != nil {
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

// ReadJSON reads name into v; it reports false when the file does not exist.
func (s *Store) ReadJSON(name string, v any) (bool, error) {
	b, err := os.ReadFile(s.Path(name))
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

// Lock takes the exclusive writer lock (flock on state.lock) and returns its release.
func (s *Store) Lock() (func(), error) {
	f, err := os.OpenFile(s.Path("state.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	for {
		err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX)
		if !errors.Is(err, syscall.EINTR) {
			break
		}
	}
	if err != nil {
		f.Close()
		return nil, err
	}
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
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
	unlock, err := s.Lock()
	if err != nil {
		return nil, false, err
	}
	defer unlock()
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

// Config is config.json.
type Config struct {
	Relay string `json:"relay"`
	Name  string `json:"name"`
}

// LoadConfig reads config.json (zero value when absent).
func (s *Store) LoadConfig() (Config, error) {
	var c Config
	_, err := s.ReadJSON("config.json", &c)
	return c, err
}

// SaveConfig writes config.json.
func (s *Store) SaveConfig(c Config) error { return s.WriteJSON("config.json", c, 0o600) }

