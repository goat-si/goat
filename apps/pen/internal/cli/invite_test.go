package cli

import (
	"bytes"
	"strings"
	"testing"
)

// pen invite waits for one event; one it does not know is a failure that names it, never a join it did not see.
func TestPenInviteFailsOnAnEventItDoesNotKnow(t *testing.T) {
	st := tmpStore(t)
	t.Setenv("PEN_HOME", st.Dir)
	fakeDaemon(t, st, `{"token":"t","relay":"r","expiresAt":1,"command":"c","windowsCommand":"w"}`+"\n"+`{"t":"replaced"}`)
	var out, errOut bytes.Buffer
	if code := RunInvite(nil, &out, &errOut); code == 0 || !strings.Contains(errOut.String(), "replaced") || strings.Contains(out.String(), "admitted") {
		t.Fatalf("exit %d, stdout %q, stderr %q; want a failure naming the event and no admission", code, out.String(), errOut.String())
	}
}

// pen invite tells apart a join that finished, one whose joiner was admitted but did not get the set, and an invite
// used without admitting anyone; only the first exits 0.
func TestPenInviteSaysWhenAJoinDidNotFinish(t *testing.T) {
	answer := `{"token":"t","relay":"r","expiresAt":1,"command":"c","windowsCommand":"w"}`
	member := `{"nodeId":"n1","signPub":"s","noisePub":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","name":"j"}`
	for _, c := range []struct {
		event, want string
		code        int
	}{
		{`{"t":"admitted","member":` + member + `,"delivered":false}`, "did not finish", 1},
		{`{"t":"burned"}`, "no admission was reported", 1},
		{`{"t":"admitted","member":` + member + `}`, "admitted j", 0},
	} {
		st := tmpStore(t)
		t.Setenv("PEN_HOME", st.Dir)
		fakeDaemon(t, st, answer+"\n"+c.event)
		var out, errOut bytes.Buffer
		code := RunInvite(nil, &out, &errOut)
		if code != c.code || !strings.Contains(out.String()+errOut.String(), c.want) {
			t.Fatalf("%s: exit %d, stdout %q, stderr %q; want exit %d saying %q", c.event, code, out.String(), errOut.String(), c.code, c.want)
		}
	}
}

// A join that did not finish is never reported on stdout as a finished one: its line goes to stderr only.
func TestPenInvitePrintsAnUnfinishedJoinOnlyToStderr(t *testing.T) {
	st := tmpStore(t)
	t.Setenv("PEN_HOME", st.Dir)
	member := `{"nodeId":"n1","signPub":"s","noisePub":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","name":"j"}`
	fakeDaemon(t, st, `{"token":"t","relay":"r","expiresAt":1,"command":"c","windowsCommand":"w"}`+"\n"+`{"t":"admitted","member":`+member+`,"delivered":false}`)
	var out, errOut bytes.Buffer
	if code := RunInvite(nil, &out, &errOut); code != 1 || strings.Contains(out.String(), "admitted") || !strings.Contains(errOut.String(), "admitted j") {
		t.Fatalf("exit %d, stdout %q, stderr %q; want exit 1 and the admission only on stderr", code, out.String(), errOut.String())
	}
}
