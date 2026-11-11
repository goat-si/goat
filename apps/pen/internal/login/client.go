package login

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
)

// Client calls one login service.
type Client struct {
	URL  string
	HTTP *http.Client
	// After waits between polls (time.After when nil).
	After func(time.Duration) <-chan time.Time
}

// New is a client for the service at url.
func New(url string) *Client {
	return &Client{URL: strings.TrimRight(url, "/"), HTTP: &http.Client{Timeout: 30 * time.Second}}
}

// Start is the device/start answer.
type Start struct {
	DeviceCode      string `json:"deviceCode"`
	UserCode        string `json:"userCode"`
	VerificationURI string `json:"verificationUri"`
	Interval        int    `json:"interval"`
	ExpiresIn       int    `json:"expiresIn"`
}

// Account is the signed-in Google account.
type Account struct {
	Sub   string `json:"sub"`
	Email string `json:"email"`
}

// OfferedMember is a node the registry lists under the account.
type OfferedMember struct {
	NodeID   string `json:"nodeId"`
	SignPub  string `json:"signPub"`
	NoisePub string `json:"noisePub"`
	Name     string `json:"name"`
}

// OfferedMesh is the mesh the registry holds for the account.
type OfferedMesh struct {
	MeshID  string          `json:"meshId"`
	Members []OfferedMember `json:"members"`
}

// Token is the device/token 200 answer.
type Token struct {
	Assertion *Assertion   `json:"assertion"`
	Account   Account      `json:"account"`
	LoginKey  Key          `json:"loginKey"`
	Mesh      *OfferedMesh `json:"mesh"`
}

// Status errors of device/token.
var (
	ErrExpired = errors.New("the sign-in code expired; run pen login again")
	ErrDenied  = errors.New("the sign-in was denied")
	// ErrOtherMesh is the registry's 409: the account is registered with another mesh.
	ErrOtherMesh = errors.New("this Google account is registered with another mesh")
	// ErrAssertionUsed is the registry's 409 for an assertion that already registered.
	ErrAssertionUsed = errors.New("this sign-in was already used to register; run pen login again")
)

// HTTPError is an unexpected answer.
type HTTPError struct {
	Status int
	Body   string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("login service answered %d: %s", e.Status, strings.TrimSpace(e.Body))
}

func (c *Client) post(ctx context.Context, path string, in any) (int, []byte, error) {
	b, err := json.Marshal(in)
	if err != nil {
		return 0, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL+path, bytes.NewReader(b))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	return c.do(req)
}

func (c *Client) do(req *http.Request) (int, []byte, error) {
	hc := c.HTTP
	if hc == nil {
		hc = http.DefaultClient
	}
	res, err := hc.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	return res.StatusCode, body, err
}

// Start begins a device flow for id under name.
func (c *Client) Start(ctx context.Context, id *ident.Identity, name string) (Start, error) {
	proof := ed25519.Sign(id.SignPriv, StartMessage(id.SignPub, id.NoisePub, name))
	code, body, err := c.post(ctx, "/v1/device/start", map[string]string{
		"signPub": ident.B64.EncodeToString(id.SignPub), "noisePub": ident.B64.EncodeToString(id.NoisePub),
		"name": name, "proof": ident.B64.EncodeToString(proof)})
	if err != nil {
		return Start{}, err
	}
	if code != http.StatusOK {
		return Start{}, &HTTPError{Status: code, Body: string(body)}
	}
	var s Start
	if err := json.Unmarshal(body, &s); err != nil || s.DeviceCode == "" || s.UserCode == "" {
		return Start{}, errors.New("login: malformed device/start answer")
	}
	if s.Interval < 1 {
		s.Interval = 2
	}
	return s, nil
}

// Poll asks once; it returns the token, or pending (false, nil), or an error. slowDown reports 429.
func (c *Client) Poll(ctx context.Context, id *ident.Identity, deviceCode string) (tok *Token, slowDown bool, err error) {
	proof := ed25519.Sign(id.SignPriv, PollMessage(deviceCode))
	code, body, err := c.post(ctx, "/v1/device/token", map[string]string{"deviceCode": deviceCode, "proof": ident.B64.EncodeToString(proof)})
	if err != nil {
		return nil, false, err
	}
	switch code {
	case http.StatusOK:
		var t Token
		if err := json.Unmarshal(body, &t); err != nil || t.Assertion == nil {
			return nil, false, fmt.Errorf("login: malformed token answer: %v", err)
		}
		return &t, false, nil
	case http.StatusPreconditionRequired:
		return nil, false, nil
	case http.StatusTooManyRequests:
		return nil, true, nil
	case http.StatusGone:
		return nil, false, ErrExpired
	case http.StatusForbidden:
		return nil, false, ErrDenied
	}
	return nil, false, &HTTPError{Status: code, Body: string(body)}
}

func (c *Client) after(d time.Duration) <-chan time.Time {
	if c.After != nil {
		return c.After(d)
	}
	return time.After(d)
}

// Wait polls at the start's interval (adding 5 s after a slow_down, as RFC 8628 says) until the
// person finishes the sign-in, and checks the assertion names id's keys under the returned key.
func (c *Client) Wait(ctx context.Context, id *ident.Identity, s Start) (*Token, error) {
	interval := time.Duration(s.Interval) * time.Second
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-c.after(interval):
		}
		tok, slow, err := c.Poll(ctx, id, s.DeviceCode)
		if err != nil {
			return nil, err
		}
		if slow {
			interval += 5 * time.Second
			continue
		}
		if tok == nil {
			continue
		}
		if err := tok.Assertion.Verify(tok.LoginKey); err != nil {
			return nil, fmt.Errorf("login: the service's assertion does not verify: %w", err)
		}
		if !tok.Assertion.ForKeys(id.SignPub, id.NoisePub) || tok.Assertion.A.Iss != c.URL || tok.Assertion.A.Sub != tok.Account.Sub {
			return nil, errors.New("login: the service's assertion is not for this node, service or account")
		}
		return tok, nil
	}
}

// Keys lists the service's current login keys.
func (c *Client) Keys(ctx context.Context) ([]Key, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.URL+"/v1/keys", nil)
	if err != nil {
		return nil, err
	}
	code, body, err := c.do(req)
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, &HTTPError{Status: code, Body: string(body)}
	}
	var k struct {
		Keys []Key `json:"keys"`
	}
	if err := json.Unmarshal(body, &k); err != nil {
		return nil, err
	}
	return k.Keys, nil
}

// Register lists id, the asserted node, under the assertion's account and meshID; id signs the
// register proof.
func (c *Client) Register(ctx context.Context, id *ident.Identity, a *Assertion, meshID string) error {
	proof := ed25519.Sign(id.SignPriv, RegisterMessage(a.Body, meshID))
	code, body, err := c.post(ctx, "/v1/mesh/register", map[string]any{"assertion": a, "meshId": meshID, "proof": ident.B64.EncodeToString(proof)})
	if err != nil {
		return err
	}
	switch code {
	case http.StatusOK:
		return nil
	case http.StatusConflict:
		var e struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(body, &e) == nil && e.Error == "assertion_used" {
			return ErrAssertionUsed
		}
		return ErrOtherMesh
	}
	return &HTTPError{Status: code, Body: string(body)}
}

// Forget removes nodeID from the registry, signed by id (that node or another under the account).
func (c *Client) Forget(ctx context.Context, id *ident.Identity, nodeID string, now time.Time) error {
	ts := uint64(now.UnixMilli())
	proof := ed25519.Sign(id.SignPriv, ForgetMessage(nodeID, ts))
	code, body, err := c.post(ctx, "/v1/mesh/forget", map[string]any{"nodeId": nodeID,
		"by": ident.B64.EncodeToString(id.SignPub), "ts": ts, "proof": ident.B64.EncodeToString(proof)})
	if err != nil {
		return err
	}
	if code != http.StatusOK {
		return &HTTPError{Status: code, Body: string(body)}
	}
	return nil
}
