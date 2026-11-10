package daemon

import "testing"

// A forget the login service refused (403) keeps its notice in pen ls after a restart, until the
// service answers it otherwise.
func TestARefusedForgetIsStillShownAfterTheBookIsReloaded(t *testing.T) {
	st := shortDir(t)
	b, err := loadForgets(st)
	if err != nil {
		t.Fatal(err)
	}
	f := PendingForget{NodeID: "aaaaaaaaaaaaaaaaaaaaaaaaaa", LoginURL: "https://login.example"}
	if err := b.add([]PendingForget{f}); err != nil {
		t.Fatal(err)
	}
	b.markRefused(f, true)
	again, err := loadForgets(st)
	if err != nil {
		t.Fatal(err)
	}
	if got := again.refusedList(); len(got) != 1 || got[0] != f {
		t.Fatalf("after a reload the refused forgets are %+v, want %+v", got, f)
	}
}
