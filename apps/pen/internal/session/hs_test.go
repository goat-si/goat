package session

import (
	"bytes"

	"github.com/flynn/noise"
	"github.com/goat-si/goat/apps/pen/internal/ident"
)

func newHS(kind byte, resp, init *ident.Identity, psk, eph []byte) (*noise.HandshakeState, error) {
	hs, err := noise.NewHandshakeState(config(kind, resp.NodeID(), true, init, resp.NoisePub, bytes.NewReader(eph)))
	if err != nil {
		return nil, err
	}
	if kind == KindJoin {
		if err := hs.SetPresharedKey(psk); err != nil {
			return nil, err
		}
	}
	return hs, nil
}

