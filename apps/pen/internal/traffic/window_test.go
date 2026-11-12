package traffic

import (
	"errors"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

// t0 starts a bucket, so the edges below are exact.
var t0 = time.Unix(1_800_000_000-1_800_000_000%int64(Span/time.Second), 0)

func totalOf(w *Window, member, relay string) (in, out uint64) {
	for _, t := range w.Totals() {
		if t.Member == member && t.Relay == relay {
			return t.In, t.Out
		}
	}
	return 0, 0
}

func TestBytesLeaveTheTotalWhenTheClockPasses24Hours(t *testing.T) {
	c := &clock{t: t0}
	w := NewWindow(c.now)
	if err := w.Add("m", "r", 100, 7); err != nil {
		t.Fatal(err)
	}
	c.t = t0.Add(10 * time.Minute)
	if err := w.Add("m", "r", 1, 1); err != nil {
		t.Fatal(err)
	}
	c.t = t0.Add(24*time.Hour - time.Nanosecond)
	if in, out := totalOf(w, "m", "r"); in != 101 || out != 8 {
		t.Fatalf("just under 24 h after: in %d out %d, want 101 and 8", in, out)
	}
	c.t = t0.Add(24 * time.Hour)
	if in, out := totalOf(w, "m", "r"); in != 0 || out != 0 {
		t.Fatalf("24 h after: in %d out %d, want both gone", in, out)
	}
	if got := w.Totals(); len(got) != 0 {
		t.Fatalf("totals %v after the window passed, want none", got)
	}
}

func TestManyMembersAndRelaysStayWithinTheEntryCap(t *testing.T) {
	c := &clock{t: t0}
	w := NewWindow(c.now)
	refused := 0
	for i := range 10 * MaxEntries {
		err := w.Add(fmt.Sprintf("member-%d", i), fmt.Sprintf("relay-%d", i%7), 1, 1)
		if errors.Is(err, ErrFull) {
			refused++
		} else if err != nil {
			t.Fatal(err)
		}
	}
	if n := w.Len(); n != MaxEntries {
		t.Fatalf("%d entries after a flood of %d keys, want the cap %d", n, 10*MaxEntries, MaxEntries)
	}
	if refused != 9*MaxEntries {
		t.Fatalf("%d keys refused, want %d", refused, 9*MaxEntries)
	}
	// A key already counted keeps counting while the table is full.
	if err := w.Add("member-0", "relay-0", 5, 5); err != nil {
		t.Fatalf("a tracked key was refused: %v", err)
	}
	// Once their bytes leave the window, the old keys make room for new ones.
	c.t = t0.Add(25 * time.Hour)
	if err := w.Add("new", "relay", 1, 1); err != nil {
		t.Fatalf("a new key after the window emptied: %v", err)
	}
	if n := w.Len(); n != 1 {
		t.Fatalf("%d entries after the old ones expired and one new key, want 1", n)
	}
}

func TestSumsSaturateInsteadOfWrapping(t *testing.T) {
	c := &clock{t: t0}
	w := NewWindow(c.now)
	w.Add("m", "r", math.MaxUint64, 1)
	w.Add("m", "r", 1, 1)
	c.t = t0.Add(Span)
	w.Add("m", "r", math.MaxUint64, 0)
	if in, out := totalOf(w, "m", "r"); in != math.MaxUint64 || out != 2 {
		t.Fatalf("in %d out %d, want in saturated at MaxUint64 and out 2", in, out)
	}
}

func TestAZeroReportTakesNoEntry(t *testing.T) {
	w := NewWindow((&clock{t: t0}).now)
	if err := w.Add("m", "r", 0, 0); err != nil || w.Len() != 0 {
		t.Fatalf("err %v, %d entries; want nil and 0", err, w.Len())
	}
}

func TestSettingTheClockBackNeitherHidesNorDropsRecentBytes(t *testing.T) {
	c := &clock{t: t0.Add(Span)}
	w := NewWindow(c.now)
	for i := range MaxEntries {
		if err := w.Add(fmt.Sprintf("member-%d", i), "r", 3, 4); err != nil {
			t.Fatal(err)
		}
	}
	c.t = t0
	if err := w.Add("new", "r", 1, 1); !errors.Is(err, ErrFull) {
		t.Fatalf("a new pair while every pair holds recent bytes: %v, want ErrFull", err)
	}
	if in, out := totalOf(w, "member-0", "r"); in != 3 || out != 4 {
		t.Fatalf("after the clock went back one bucket: in %d out %d, want 3 and 4", in, out)
	}
}

// The guarantee is in whole buckets: a clock set back by just under 24 hours minus one bucket keeps a count made
// just after a bucket began.
func TestAClockSetBackJustUnder23h45KeepsTheCount(t *testing.T) {
	c := &clock{t: t0.Add(time.Nanosecond)}
	w := NewWindow(c.now)
	w.Add("m", "r", 9, 9)
	c.t = c.t.Add(-(24*time.Hour - Span - time.Nanosecond))
	w.Add("m", "r", 1, 1)
	if in, out := totalOf(w, "m", "r"); in != 10 || out != 10 {
		t.Fatalf("in %d out %d after the clock went back just under 23 h 45 min, want 10 and 10", in, out)
	}
}

// Buckets are chosen by the wall clock, so where the totals start must be too: with monotonic readings, Since would
// keep the daemon's start after the wall clock moved a day ahead.
func TestSinceIsOnTheWallClock(t *testing.T) {
	w := NewWindow(time.Now)
	if s := w.Since().String(); strings.Contains(s, " m=") {
		t.Fatalf("Since() = %s carries a monotonic reading", s)
	}
}
