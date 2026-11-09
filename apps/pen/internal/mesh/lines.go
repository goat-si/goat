package mesh

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relay"
	"github.com/goat-si/goat/apps/pen/internal/wire"
)

// Link is the secure record channel mesh lines run on.
type Link interface {
	Send(p []byte) error
	Recv(ctx context.Context) ([]byte, error)
	Close(code uint16) error
}

const (
	// MaxLine caps one mesh line.
	MaxLine = 256 << 10
	// LineRecords caps records per records line.
	LineRecords = 64
	maxHave     = 4096
	maxRecord   = 65519
)

var errLine = &relay.CloseError{Code: wire.CodeCrypto}

// Msg is any mesh or join line.
type Msg struct {
	T       string    `json:"t"`
	Have    []string  `json:"have,omitempty"`
	Records []*Record `json:"records,omitempty"`
	Mesh    string    `json:"mesh,omitempty"`
	Inviter string    `json:"inviter,omitempty"`
	Nonce   string    `json:"nonce,omitempty"`
	Card    *Card     `json:"card,omitempty"`
	Reason  string    `json:"reason,omitempty"`
}

// Lines frames LF-terminated JSON lines over records.
type Lines struct {
	L   Link
	buf []byte
}

// Write sends v as one line, split into records of at most 65519 bytes.
func (c *Lines) Write(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	if len(b) > MaxLine {
		return errors.New("mesh: line over 256 KiB")
	}
	for len(b) > 0 {
		n := min(len(b), maxRecord)
		if err := c.L.Send(b[:n]); err != nil {
			return err
		}
		b = b[n:]
	}
	return nil
}

// Read returns the next line; an oversized or malformed one closes the link 4400.
func (c *Lines) Read(ctx context.Context) (*Msg, error) {
	for {
		if i := bytes.IndexByte(c.buf, '\n'); i >= 0 {
			line := c.buf[:i]
			c.buf = append([]byte(nil), c.buf[i+1:]...)
			var m Msg
			if err := json.Unmarshal(line, &m); err != nil || m.T == "" || len(m.Have) > maxHave {
				c.L.Close(wire.CodeCrypto)
				return nil, errLine
			}
			return &m, nil
		}
		if len(c.buf) > MaxLine {
			c.L.Close(wire.CodeCrypto)
			return nil, errLine
		}
		p, err := c.L.Recv(ctx)
		if err != nil {
			return nil, err
		}
		c.buf = append(c.buf, p...)
	}
}

// writeRecords sends recs as records lines of at most LineRecords.
func (c *Lines) writeRecords(recs []*Record) error {
	for len(recs) > 0 {
		n := min(len(recs), LineRecords)
		if err := c.Write(Msg{T: "records", Records: recs[:n]}); err != nil {
			return err
		}
		recs = recs[n:]
	}
	return nil
}

func randomNonce() (string, error) {
	b := make([]byte, nonceBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return ident.B64.EncodeToString(b), nil
}
