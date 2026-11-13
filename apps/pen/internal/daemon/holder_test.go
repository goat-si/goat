package daemon

import (
	"bufio"
	"net"
	"testing"
)

func pipeQueue(t *testing.T) (*holderQueue, net.Conn) {
	t.Helper()
	near, far := net.Pipe()
	t.Cleanup(func() { near.Close(); far.Close() })
	q := newHolderQueue(near, nil) // a pipe cannot half-close, so nothing is drained
	go q.run()
	t.Cleanup(q.fail)
	return q, far
}

func TestHolderLinesAreWrittenInReservationOrderEvenWhenAnEarlierAnswerIsReadyLast(t *testing.T) {
	q, far := pipeQueue(t)
	answer, _ := q.reserve()
	event, _ := q.push([]byte("event\n"))
	r := bufio.NewReader(far)
	answer.fill([]byte("answer\n"))
	for _, want := range []string{"answer\n", "event\n"} {
		if got, _ := r.ReadString('\n'); got != want {
			t.Fatalf("read %q, want %q", got, want)
		}
	}
	if !q.wait(answer) || !q.wait(event) {
		t.Fatal("written entries report failure")
	}
}

func TestFailingTheQueueReleasesAnOpWaitingBehindAnUnreadyAnswerAndWritesReplacedAtOnce(t *testing.T) {
	q, far := pipeQueue(t)
	answer, _ := q.reserve()
	waited := make(chan bool, 1)
	go func() { waited <- q.wait(answer) }()
	done := make(chan struct{})
	go func() { q.failWith([]byte("replaced\n")); close(done) }()
	if got, _ := bufio.NewReader(far).ReadString('\n'); got != "replaced\n" {
		t.Fatalf("read %q, want the replaced line", got)
	}
	<-done
	if <-waited {
		t.Fatal("an unwritten answer reported success")
	}
	if _, ok := q.push([]byte("late\n")); ok {
		t.Fatal("a failed queue took a line")
	}
}

func TestAFailedWriteEndsTheQueueAndNothingIsWrittenAfterIt(t *testing.T) {
	q, far := pipeQueue(t)
	far.Close() // the holder is gone: the next write fails
	e, _ := q.push([]byte("answer\n"))
	if q.wait(e) {
		t.Fatal("a write to a closed holder reported success")
	}
	<-q.dead
	q.mu.Lock()
	failed := q.failed
	q.mu.Unlock()
	if !failed {
		t.Fatal("a failed write left the queue open")
	}
}

func TestAFullHolderQueueFailsInsteadOfGrowing(t *testing.T) {
	q, _ := pipeQueue(t)
	first, _ := q.reserve() // never ready: nothing is written, so the queue only fills
	for range holderQueueCap - 1 {
		if _, ok := q.push([]byte("x\n")); !ok {
			t.Fatal("queue failed before its cap")
		}
	}
	if _, ok := q.push([]byte("x\n")); ok {
		t.Fatal("queue took a line past its cap")
	}
	if q.wait(first) {
		t.Fatal("an entry of a failed queue reported success")
	}
}
