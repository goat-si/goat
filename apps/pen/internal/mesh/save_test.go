package mesh

import (
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
