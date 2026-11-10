package mesh

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
)

// pipeEnd is one end of an in-memory Link.
type pipeEnd struct {
	in, out chan []byte
	done    chan struct{}
	once    *sync.Once
}

func pipe() (*pipeEnd, *pipeEnd) {
	a, b := make(chan []byte, 64), make(chan []byte, 64)
	done, once := make(chan struct{}), &sync.Once{}
	return &pipeEnd{in: a, out: b, done: done, once: once}, &pipeEnd{in: b, out: a, done: done, once: once}
}

func (p *pipeEnd) Send(b []byte) error {
	select {
	case p.out <- append([]byte(nil), b...):
		return nil
	case <-p.done:
		return errors.New("closed")
	}
}

func (p *pipeEnd) Recv(ctx context.Context) ([]byte, error) {
	select {
	case b := <-p.in:
		return b, nil
	case <-p.done:
		select {
		case b := <-p.in:
			return b, nil
		default:
		}
		return nil, errors.New("closed")
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (p *pipeEnd) Close(uint16) error {
	p.once.Do(func() { close(p.done) })
	return nil
}

// A member that learns of its own revoke during the refresh before a Google join decides, signs
// nothing and queues nothing: it refuses as not a member, so the joiner can try another.
func TestAMemberThatLearnsItsRevokeDuringTheRefreshAdmitsAndQueuesNothing(t *testing.T) {
	for _, locked := range []bool{false, true} {
		f, y, j := detID(1), detID(2), detID(3)
		b, found := newMesh(t, f)
		ay := b.admit(f, y, found)
		recs := []*Record{found, ay}
		if locked {
			recs = append(recs, b.sign(f, TypeLock, []*Record{ay}, Fields{On: true}))
		}
		s := NewStore(nil, b.meshID)
		if _, err := s.Merge(recs); err != nil {
			t.Fatal(err)
		}
		if locked && !s.View().Locked {
			t.Fatal("setup: the mesh is not locked")
		}
		rv := b.sign(f, TypeRevoke, recs[len(recs)-1:], Fields{Subjects: []string{pub(y)}})
		queued := 0
		srv, cli := pipe()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		served := make(chan error, 1)
		go func() {
			_, err := ServeAccount(ctx, srv, j.NoisePub, AccountAdmission{ID: y, Store: s, Now: time.Now,
				Check: func(json.RawMessage, *View) (Claim, error) {
					return Claim{SignPub: pub(j), NoisePub: ident.B64.EncodeToString(j.NoisePub), Email: "j@example.com", Hash: HashOf([]byte("assertion"))}, nil
				},
				Queue:   func(*Card, Claim) (string, error) { queued++; return "q", nil },
				Refresh: func() { s.Merge([]*Record{rv}) },
			})
			served <- err
		}()
		_, err := AccountJoin(ctx, cli, j, "j", json.RawMessage(`{"a":1}`))
		serr := <-served
		cancel()
		var refused *RefusedError
		if !errors.As(err, &refused) || !refused.NotMember {
			t.Fatalf("locked %v: the joiner got %v (served %v), want a not-a-member refusal", locked, err, serr)
		}
		if queued != 0 || s.Len() != len(recs)+1 {
			t.Fatalf("locked %v: queued %d request(s); the store holds %d records, want %d", locked, queued, s.Len(), len(recs)+1)
		}
	}
}
