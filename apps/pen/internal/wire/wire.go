// Package wire holds the relay mux frames, close codes, uplink challenge and ack texts.
package wire

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// Close codes (contract "Close codes").
const (
	CodeNormal        uint16 = 1000
	CodeCrypto        uint16 = 4400
	CodeNotAdmitted   uint16 = 4401
	CodeRelayProtocol uint16 = 4402
	CodeRelayAuth     uint16 = 4403
	CodeOffline       uint16 = 4404
	CodeTimeout       uint16 = 4408
	CodeReplaced      uint16 = 4409
	CodeCaps          uint16 = 4429
	// CodeNotKept closes a mesh sync whose records the member could not keep (its state folder
	// cannot be written).
	CodeNotKept uint16 = 4507
	// CodeMeshFull closes a mesh sync that brought a record the member refused for its record
	// cap. Relays never use it (their 4429 means busy).
	CodeMeshFull uint16 = 4508
	// CodeEpoch closes a mesh sync between a node of a mesh of the shared epoch (ADR-0026) and a
	// peer that does not announce it.
	CodeEpoch uint16 = 4509
)

// Mux frame types on the uplink.
const (
	FrameOpen  byte = 1
	FrameData  byte = 2
	FrameClose byte = 3
)

// HeaderLen is the mux frame header: type u8 + sid u32 LE.
const HeaderLen = 5

// MaxMessage is the relay's per-message cap.
const MaxMessage = 1 << 20

// AckEvery is how many received bytes trigger a cumulative ack.
const AckEvery = 64 << 10

// ErrReserved marks frame types 4-7, which close the uplink 4402 in v1.0.
var ErrReserved = errors.New("wire: reserved frame type")

// Frame is one uplink mux frame.
type Frame struct {
	Type    byte
	SID     uint32
	Payload []byte
}

// Encode serializes f.
func (f Frame) Encode() []byte {
	b := make([]byte, HeaderLen+len(f.Payload))
	b[0] = f.Type
	binary.LittleEndian.PutUint32(b[1:5], f.SID)
	copy(b[HeaderLen:], f.Payload)
	return b
}

// CloseFrame builds a CLOSE frame with code.
func CloseFrame(sid uint32, code uint16) Frame {
	p := make([]byte, 2)
	binary.LittleEndian.PutUint16(p, code)
	return Frame{Type: FrameClose, SID: sid, Payload: p}
}

// DecodeFrame parses an uplink message. The payload aliases b.
func DecodeFrame(b []byte) (Frame, error) {
	if len(b) < HeaderLen {
		return Frame{}, errors.New("wire: short frame")
	}
	f := Frame{Type: b[0], SID: binary.LittleEndian.Uint32(b[1:5]), Payload: b[HeaderLen:]}
	switch f.Type {
	case FrameOpen:
		if len(f.Payload) != 0 {
			return Frame{}, errors.New("wire: OPEN with payload")
		}
	case FrameData:
	case FrameClose:
		if len(f.Payload) != 2 {
			return Frame{}, errors.New("wire: CLOSE payload must be 2 bytes")
		}
	case 4, 5, 6, 7:
		return Frame{}, ErrReserved
	default:
		return Frame{}, fmt.Errorf("wire: unknown frame type %d", f.Type)
	}
	return f, nil
}

// CloseCode reads a CLOSE frame's code.
func (f Frame) CloseCode() uint16 { return binary.LittleEndian.Uint16(f.Payload) }

// ChallengePrefix is the uplink challenge domain separator.
const ChallengePrefix = "pen-relay-v1"

// ChallengeMessage is the byte string the node signs to authenticate its uplink.
func ChallengeMessage(relayOrigin, nodeID string, challenge []byte) []byte {
	m := make([]byte, 0, len(ChallengePrefix)+len(relayOrigin)+len(nodeID)+len(challenge))
	m = append(m, ChallengePrefix...)
	m = append(m, relayOrigin...)
	m = append(m, nodeID...)
	return append(m, challenge...)
}

// RelayOrigin is ws(s):// plus the WHATWG URL.host of a relay URL (http(s) or ws(s)).
func RelayOrigin(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	var scheme, defPort string
	switch strings.ToLower(u.Scheme) {
	case "https", "wss":
		scheme, defPort = "wss://", "443"
	case "http", "ws":
		scheme, defPort = "ws://", "80"
	default:
		return "", fmt.Errorf("wire: relay URL scheme %q", u.Scheme)
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return "", errors.New("wire: relay URL has no host")
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if p := u.Port(); p != "" && p != defPort {
		host += ":" + p
	}
	return scheme + host, nil
}

// WebSocketURL joins a relay base URL (http(s) or ws(s)) and a path into a ws(s) URL.
func WebSocketURL(relayURL, path string) (string, error) {
	u, err := url.Parse(relayURL)
	if err != nil {
		return "", err
	}
	switch strings.ToLower(u.Scheme) {
	case "https", "wss":
		u.Scheme = "wss"
	case "http", "ws":
		u.Scheme = "ws"
	default:
		return "", fmt.Errorf("wire: relay URL scheme %q", u.Scheme)
	}
	u.Path = strings.TrimSuffix(u.Path, "/") + path
	u.RawQuery, u.Fragment = "", ""
	return u.String(), nil
}

// FormatAck is the cumulative ack text.
func FormatAck(total uint64) string { return "a:" + strconv.FormatUint(total, 10) }

// maxAck is the largest ack the relay accepts (2^53 - 1, a JavaScript safe integer).
const maxAck = 1<<53 - 1

// ParseAck parses "a:<decimal>" (no sign, no leading zeros, at most 2^53 - 1).
func ParseAck(s string) (uint64, bool) {
	rest, ok := strings.CutPrefix(s, "a:")
	if !ok || rest == "" || len(rest) > 1 && rest[0] == '0' {
		return 0, false
	}
	for _, c := range rest {
		if c < '0' || c > '9' {
			return 0, false
		}
	}
	n, err := strconv.ParseUint(rest, 10, 64)
	return n, err == nil && n <= maxAck
}
