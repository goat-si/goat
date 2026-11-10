package mesh

import (
	"context"
	"errors"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// A member that keeps sending records lines in one mesh session would keep its peer verifying
// signatures; the peer cuts the session once it has received more records than an honest member
// can hold (MaxRecords stored plus MaxPool waiting), on either side of the session.
func TestASyncSessionThatSendsMoreRecordsThanAMeshCanHoldIsCut(t *testing.T) {
	f := detID(1)
	src, err := Found(nil, f, "f", 1)
	if err != nil {
		t.Fatal(err)
	}
	for i := range LineRecords - 1 {
		if _, err := src.Append(f, TypeName, int64(i+2), Fields{Subject: pub(f), Name: "n" + string(rune('a'+i%26))}); err != nil {
			t.Fatal(err)
		}
	}
	line := Msg{T: "records", Records: src.Records()}
	if len(line.Records) != LineRecords {
		t.Fatalf("%d records in the flood line, want %d", len(line.Records), LineRecords)
	}
	lines := (MaxRecords+MaxPool)/LineRecords + 8
	for _, side := range []string{"responder", "initiator"} {
		t.Run(side, func(t *testing.T) {
			victim := NewStore(nil, src.MeshID)
			x, y := relay.Pipe()
			x.(relay.QueueLimiter).SetQueueLimit(relay.MaxQueued)
			y.(relay.QueueLimiter).SetQueueLimit(relay.MaxQueued)
			errc := make(chan error, 1)
			go func() {
				if side == "responder" {
					errc <- SyncRespond(context.Background(), y, victim, nil, nil)
				} else {
					errc <- SyncInitiate(context.Background(), y, victim, nil, nil)
				}
			}()
			flood := &Lines{L: x}
			if _, err := flood.Read(context.Background()); err != nil {
				t.Fatal(err)
			}
			if err := flood.Write(Msg{T: "hello", Pen: Version}); err != nil {
				t.Fatal(err)
			}
			for range lines {
				if err := flood.Write(line); err != nil {
					break
				}
			}
			_ = flood.Write(Msg{T: "done"})
			err := <-errc
			var ce *relay.CloseError
			if !errors.As(err, &ce) || ce.Code != wire.CodeCrypto {
				t.Fatalf("%s after %d records lines: %v, want closed %d", side, lines, err, wire.CodeCrypto)
			}
		})
	}
}
