package mesh

import (
	"errors"
	"os"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/state"
)

// N1: a save that took its snapshot before a revoke was stored must not replace the file the
// later save wrote with the revoke: after a reload the revoke still holds.
func TestAnOlderSaveNeverReplacesANewerMeshFile(t *testing.T) {
	st, err := state.OpenDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f, y := detID(1), detID(2)
	b, found := newMesh(t, f)
	ay := b.admit(f, y, found)
	s := NewStore(st, b.meshID)
	if _, err := s.Merge([]*Record{found, ay}); err != nil {
		t.Fatal(err)
	}
	rv := b.sign(f, TypeRevoke, []*Record{ay}, Fields{Subjects: []string{pub(y)}})
	paused, resume := make(chan struct{}), make(chan struct{})
	first := true
	s.afterSnapshot = func() {
		if first {
			first = false
			close(paused)
			<-resume
		}
	}
	waiting := make(chan struct{})
	s.saveWaits = func() { close(waiting) }
	old := make(chan error, 1)
	go func() { old <- s.Save() }()
	<-paused
	if _, err := s.Merge([]*Record{rv}); err != nil {
		t.Fatal(err)
	}
	newer := make(chan error, 1)
	go func() { newer <- s.Save() }()
	// Either the newer save waits for the older one, or (without one save at a time) it writes
	// its file first; then the older save resumes.
	select {
	case <-waiting:
	case err := <-newer:
		newer <- err
	}
	close(resume)
	if err := <-old; err != nil {
		t.Fatal(err)
	}
	if err := <-newer; err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(st)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := loaded.View().Revoked[pub(y)]; !ok {
		t.Fatal("after a reload the revoke is gone: an older save replaced the newer file")
	}
}

// Q1: a save of a store that took its snapshot before the node moved to another mesh must not
// overwrite the adopted mesh: mesh.json decides, so after a reload the adopted mesh is there.
func TestASaveOfAReplacedStoreNeverOverwritesTheAdoptedMesh(t *testing.T) {
	st, err := state.OpenDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	bx, foundX := newMesh(t, detID(1))
	old := NewStore(st, bx.meshID)
	if _, err := old.Merge([]*Record{foundX}); err != nil {
		t.Fatal(err)
	}
	if err := old.Save(); err != nil {
		t.Fatal(err)
	}
	if _, err := old.Merge([]*Record{bx.admit(detID(1), detID(3), foundX)}); err != nil {
		t.Fatal(err)
	}
	paused, resume := make(chan struct{}), make(chan struct{})
	old.afterSnapshot = func() { close(paused); <-resume }
	done := make(chan error, 1)
	go func() { done <- old.Save() }()
	<-paused
	by, foundY := newMesh(t, detID(2))
	adopted := NewStore(st, by.meshID)
	if _, err := adopted.Merge([]*Record{foundY}); err != nil {
		t.Fatal(err)
	}
	adopted.Adopt()
	if err := adopted.Save(); err != nil {
		t.Fatal(err)
	}
	close(resume)
	<-done
	loaded, err := Load(st)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.MeshID != by.meshID {
		t.Fatalf("mesh.json holds mesh %s after the old set's save, want the adopted %s", loaded.MeshID, by.meshID)
	}
}

// Q1: two stores of one mesh (another process, or a second store in this one) that save out of
// order never lose each other's records: records only grow, so the file keeps the union.
func TestTwoStoresOfOneMeshSavingOutOfOrderKeepEveryRecord(t *testing.T) {
	st, err := state.OpenDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f, y := detID(1), detID(2)
	b, found := newMesh(t, f)
	ay := b.admit(f, y, found)
	rv := b.sign(f, TypeRevoke, []*Record{ay}, Fields{Subjects: []string{pub(y)}})
	stale := NewStore(st, b.meshID)
	fresh := NewStore(st, b.meshID)
	if _, err := stale.Merge([]*Record{found, ay}); err != nil {
		t.Fatal(err)
	}
	if _, err := fresh.Merge([]*Record{found, ay, rv}); err != nil {
		t.Fatal(err)
	}
	if err := fresh.Save(); err != nil {
		t.Fatal(err)
	}
	if err := stale.Save(); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(st)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := loaded.View().Revoked[pub(y)]; !ok {
		t.Fatal("the stale store's save dropped the revoke the other store had written")
	}
}

// Q1: once mesh.json was removed (pen leave), a store that had it does not write it back.
func TestASaveAfterTheMeshFileWasRemovedDoesNotRecreateIt(t *testing.T) {
	st, err := state.OpenDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	b, found := newMesh(t, detID(1))
	s := NewStore(st, b.meshID)
	if _, err := s.Merge([]*Record{found}); err != nil {
		t.Fatal(err)
	}
	if err := s.Save(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(st.Path("mesh.json")); err != nil {
		t.Fatal(err)
	}
	if err := s.Save(); !errors.Is(err, ErrRemoved) {
		t.Fatalf("save after removal: %v, want ErrRemoved", err)
	}
	if _, err := Load(st); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("mesh.json came back: %v", err)
	}
}
