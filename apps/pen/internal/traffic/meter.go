package traffic

import (
	"context"

	"github.com/goat-si/goat/apps/pen/internal/stream"
)

// Meter wraps l and calls add with the DATA payload of every record l sends (out) and receives (in). Framing,
// CREDIT and FIN records and the bytes of the layers below are not counted. add runs on the sending and the
// receiving goroutine, so it must be safe for concurrent use.
func Meter(l stream.Link, add func(in, out uint64)) stream.Link { return &meter{Link: l, add: add} }

type meter struct {
	stream.Link
	add func(in, out uint64)
}

func (m *meter) Send(p []byte) error {
	err := m.Link.Send(p)
	if err == nil && len(p) > 1 && p[0] == stream.TypeData {
		m.add(0, uint64(len(p)-1))
	}
	return err
}

func (m *meter) Recv(ctx context.Context) ([]byte, error) {
	p, err := m.Link.Recv(ctx)
	if err == nil && len(p) > 1 && p[0] == stream.TypeData {
		m.add(uint64(len(p)-1), 0)
	}
	return p, err
}
