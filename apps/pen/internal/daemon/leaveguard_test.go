package daemon

import (
	"context"
	"strings"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/relaytest"
)

// A leave already running (here held at its state lock) makes a second leave say so instead of
// running the leave again beside it; the first then finishes.
func TestASecondLeaveWhileOneRunsSaysSo(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	unlock, err := a.st.Lock()
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 2)
	for range 2 {
		go func() {
			var r struct{ Results []PushResult }
			results <- Call(a.st, Request{Op: "leave"}, &r)
		}()
	}
	if err := <-results; err == nil || !strings.Contains(err.Error(), "already leaving") {
		unlock()
		t.Fatalf("second leave: %v, want one that says a leave is already running", err)
	}
	unlock()
	if err := <-results; err != nil {
		t.Fatalf("the running leave: %v", err)
	}
}
