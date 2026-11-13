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
